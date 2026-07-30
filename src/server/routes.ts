import { explorerAccount, explorerTx, NETWORK_URL } from '../config';
import { getClient } from '../ledger/client';
import { depositCover } from '../ledger/broker';
import { defaultLoan, impairLoan, originateLoan, payInstallment, unimpairLoan } from '../ledger/loan';
import { computeNav, readPosition, type Nav } from '../ledger/nav';
import { getBroker, getLoan, getVault, iouBalance, validatedCloseTime } from '../ledger/read';
import { depositToVault, withdrawFromVault } from '../ledger/vault';
import { shares } from '../ledger/amounts';
import { loadWallets, type Role } from '../ledger/wallets';
import { DEMO_DEALS } from '../demo/deals';
import { underwrite, validate } from '../underwriting/engine';
import { GRADE_TABLE, POLICY } from '../underwriting/policy';
import { scheduleLabel, toOnChainTerms } from '../underwriting/terms';
import type { DealInput } from '../underwriting/types';
import { loadState, loadTxLog, updateState } from '../store';
import { HttpError } from './http-error';

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  handle: (ctx: RouteContext) => Promise<unknown>;
}

/** Nothing in here touches `xrpl` types directly — that stays behind src/ledger. */

function requireVault(): { vaultId: string; brokerId?: string } {
  const state = loadState();
  if (!state.vaultId) {
    throw new HttpError(409, 'No fund is open. Run `npm run lifecycle` or `npm run demo` first.');
  }
  return { vaultId: state.vaultId, brokerId: state.brokerId };
}

function asRole(value: unknown, fallback: Role): Role {
  const allowed: Role[] = ['issuer', 'broker', 'lp', 'lp2', 'borrower'];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as Role)) {
    throw new HttpError(400, `Unknown role "${String(value)}". Expected one of ${allowed.join(', ')}.`);
  }
  return value as Role;
}

function amountOf(body: unknown): number {
  const amount = (body as { amount?: unknown }).amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'Expected a positive numeric "amount".');
  }
  return amount;
}

const navPayload = (nav: Nav) => ({
  assetsTotal: nav.assetsTotal,
  assetsAvailable: nav.assetsAvailable,
  lossUnrealized: nav.lossUnrealized,
  netAssets: nav.netAssets,
  sharesOutstanding: nav.sharesOutstandingScaled,
  navPerShare: nav.navPerShare,
  // Both rates are exposed because neither is queryable from the protocol and
  // they are not the same number whenever there is an unrealized loss.
  depositRatePerShare: nav.depositRatePerShare,
  redemptionRatePerShare: nav.redemptionRatePerShare,
});

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/health',
    summary: 'Network, and whether a fund is open',
    handle: async () => {
      const client = await getClient();
      const { ripple, unixMs } = await validatedCloseTime(client);
      const state = loadState();
      return {
        network: NETWORK_URL,
        connected: client.isConnected(),
        validatedCloseTime: { ripple, iso: new Date(unixMs).toISOString() },
        fundOpen: Boolean(state.vaultId),
        vaultId: state.vaultId ?? null,
        brokerId: state.brokerId ?? null,
      };
    },
  },

  {
    method: 'GET',
    path: '/api/fund',
    summary: 'Vault NAV, cover position, and LP positions',
    handle: async () => {
      const { vaultId, brokerId } = requireVault();
      const client = await getClient();
      const w = loadWallets();

      const vault = await getVault(client, vaultId);
      const nav = computeNav(vault);
      const broker = brokerId ? await getBroker(client, brokerId) : null;

      return {
        vault: {
          vaultId,
          account: vault.account,
          explorer: explorerAccount(vault.account),
          shareMptId: vault.shareMptId,
          scale: vault.scale,
          data: vault.data,
        },
        nav: navPayload(nav),
        cover: broker && {
          available: broker.coverAvailable,
          required: broker.coverRequired,
          ratio: broker.coverRatio === Infinity ? null : broker.coverRatio,
          minimumPercent: broker.coverRateMinimum / 1000,
          liquidationPercent: broker.coverRateLiquidation / 1000,
          debtOutstanding: broker.debtTotal,
          debtMaximum: broker.debtMaximum,
          originationBlocked: broker.originationBlocked,
        },
        positions: [
          await readPosition(client, w.lp.classicAddress, vaultId, nav),
          await readPosition(client, w.lp2.classicAddress, vaultId, nav),
        ],
        navHistory: loadState().navHistory,
      };
    },
  },

  {
    method: 'GET',
    path: '/api/loans',
    summary: 'Every loan, read live from the ledger',
    handle: async () => {
      const client = await getClient();
      const { ripple: now } = await validatedCloseTime(client);
      const state = loadState();

      return Promise.all(
        state.loans.map(async (record) => {
          let onLedger = null;
          try {
            const loan = await getLoan(client, record.loanId);
            const daysPastDue = Math.max(0, (now - loan.nextPaymentDueDate) / 86_400);
            onLedger = {
              ...loan,
              daysPastDue,
              defaultableAt: loan.nextPaymentDueDate + loan.gracePeriod,
              defaultableNow: now > loan.nextPaymentDueDate + loan.gracePeriod && loan.impaired,
              scheduleLabel: scheduleLabel(
                record.onChain.paymentTotal - loan.paymentRemaining,
                record.onChain,
              ),
            };
          } catch {
            onLedger = null; // deleted
          }
          return {
            loanId: record.loanId,
            dealId: record.dealId,
            address: record.underwriting.address,
            status: record.status,
            grade: record.underwriting.decision.grade,
            originationHash: record.originationHash,
            explorer: explorerTx(record.originationHash),
            terms: record.underwriting.terms,
            onChainTerms: record.onChain,
            disclosure: record.onChain.compression,
            onLedger,
          };
        }),
      );
    },
  },

  {
    method: 'GET',
    path: '/api/loans/:loanId',
    summary: 'One loan, with its underwriting',
    handle: async ({ params }) => {
      const record = loadState().loans.find((l) => l.loanId === params.loanId);
      if (!record) throw new HttpError(404, `No loan ${params.loanId}`);
      const client = await getClient();
      return { ...record, onLedger: await getLoan(client, record.loanId) };
    },
  },

  {
    method: 'GET',
    path: '/api/policy',
    summary: 'The credit box and the grade table',
    handle: async () => ({ policy: POLICY, grades: GRADE_TABLE }),
  },

  {
    method: 'GET',
    path: '/api/deals',
    summary: 'The demo deals with their underwriting',
    handle: async () =>
      DEMO_DEALS.map((deal) => {
        const result = underwrite(deal);
        return {
          input: deal,
          underwriting: result,
          onChainTerms: result.terms ? toOnChainTerms(result.terms, deal.address) : null,
        };
      }),
  },

  {
    method: 'POST',
    path: '/api/underwrite',
    summary: 'Score an arbitrary deal — pure, no ledger writes',
    handle: async ({ body }) => {
      const deal = body as DealInput;
      // Throws with the specific missing field rather than defaulting it to zero.
      validate(deal);
      const result = underwrite(deal);
      return {
        underwriting: result,
        onChainTerms: result.terms ? toOnChainTerms(result.terms, deal.address) : null,
      };
    },
  },

  {
    method: 'GET',
    path: '/api/transactions',
    summary: 'Every transaction this build has submitted',
    handle: async () =>
      loadTxLog().map((entry) => ({ ...entry, explorer: explorerTx(entry.hash) })),
  },

  {
    method: 'GET',
    path: '/api/balances',
    summary: 'Demo USD balances by role',
    handle: async () => {
      const client = await getClient();
      const w = loadWallets();
      const issuer = w.issuer.classicAddress;
      const roles: Role[] = ['broker', 'lp', 'lp2', 'borrower'];
      const out: Record<string, { address: string; usd: number; explorer: string }> = {};
      for (const role of roles) {
        out[role] = {
          address: w[role].classicAddress,
          usd: await iouBalance(client, w[role].classicAddress, issuer),
          explorer: explorerAccount(w[role].classicAddress),
        };
      }
      return out;
    },
  },

  // ── Writes ─────────────────────────────────────────────────────────────

  {
    method: 'POST',
    path: '/api/deposit',
    summary: 'LP subscribes to the fund',
    handle: async ({ body }) => {
      const { vaultId } = requireVault();
      const client = await getClient();
      const w = loadWallets();
      const role = asRole((body as { role?: unknown }).role, 'lp');
      const result = await depositToVault(client, w[role], vaultId, amountOf(body), w.issuer.classicAddress);
      return { hash: result.hash, explorer: result.explorer, nav: navPayload(computeNav(await getVault(client, vaultId))) };
    },
  },

  {
    method: 'POST',
    path: '/api/withdraw',
    summary: 'LP redeems shares (share count, not asset amount)',
    handle: async ({ body }) => {
      const { vaultId } = requireVault();
      const client = await getClient();
      const w = loadWallets();
      const role = asRole((body as { role?: unknown }).role, 'lp');
      const vault = await getVault(client, vaultId);

      const requested = (body as { shares?: unknown }).shares;
      if (typeof requested !== 'number' && typeof requested !== 'string') {
        throw new HttpError(400, 'Expected "shares" — a share count, not an asset amount.');
      }
      const result = await withdrawFromVault(client, w[role], vaultId, shares(vault.shareMptId, requested));
      return { hash: result.hash, explorer: result.explorer, nav: navPayload(computeNav(await getVault(client, vaultId))) };
    },
  },

  {
    method: 'POST',
    path: '/api/cover',
    summary: 'Manager posts more first-loss capital',
    handle: async ({ body }) => {
      const { brokerId } = requireVault();
      if (!brokerId) throw new HttpError(409, 'No LoanBroker registered.');
      const client = await getClient();
      const w = loadWallets();
      const result = await depositCover(client, w.broker, brokerId, amountOf(body), w.issuer.classicAddress);
      return { hash: result.hash, explorer: result.explorer, cover: await getBroker(client, brokerId) };
    },
  },

  {
    method: 'POST',
    path: '/api/originate',
    summary: 'Underwrite a deal and originate it if approved',
    handle: async ({ body }) => {
      const { brokerId } = requireVault();
      if (!brokerId) throw new HttpError(409, 'No LoanBroker registered.');

      const deal = body as DealInput;
      validate(deal);
      const result = underwrite(deal);
      if (!result.decision.approved || !result.terms) {
        // A decline is a legitimate outcome, not a server error — return it as one,
        // with the reasons, so the caller can show why.
        return { approved: false, underwriting: result };
      }

      const client = await getClient();
      const w = loadWallets();
      const onChain = toOnChainTerms(result.terms, deal.address);
      const loan = await originateLoan(client, w.borrower, w.broker, brokerId, onChain);

      updateState((s) => {
        s.deals.push({ dealId: deal.id, input: deal, underwriting: result });
        s.loans.push({
          loanId: loan.loanId,
          dealId: deal.id,
          borrower: w.borrower.classicAddress,
          originationHash: loan.submit.hash,
          underwriting: result,
          onChain,
          status: 'active',
        });
      });

      return {
        approved: true,
        loanId: loan.loanId,
        hash: loan.submit.hash,
        explorer: loan.submit.explorer,
        underwriting: result,
        onChainTerms: onChain,
      };
    },
  },

  {
    method: 'POST',
    path: '/api/loans/:loanId/pay',
    summary: 'Borrower makes one installment',
    handle: async ({ params }) => {
      const client = await getClient();
      const w = loadWallets();
      const { submit, due } = await payInstallment(client, w.borrower, params.loanId!, w.issuer.classicAddress);
      return { hash: submit.hash, explorer: submit.explorer, due, loan: await getLoan(client, params.loanId!) };
    },
  },

  {
    method: 'POST',
    path: '/api/loans/:loanId/impair',
    summary: 'Move a loan to the watchlist (provisions it)',
    handle: async ({ params }) => {
      const client = await getClient();
      const w = loadWallets();
      const result = await impairLoan(client, w.broker, params.loanId!);
      updateState((s) => {
        const record = s.loans.find((l) => l.loanId === params.loanId);
        if (record) record.status = 'impaired';
      });
      return { hash: result.hash, explorer: result.explorer, loan: await getLoan(client, params.loanId!) };
    },
  },

  {
    method: 'POST',
    path: '/api/loans/:loanId/unimpair',
    summary: 'Take a loan back off the watchlist',
    handle: async ({ params }) => {
      const client = await getClient();
      const w = loadWallets();
      const result = await unimpairLoan(client, w.broker, params.loanId!);
      updateState((s) => {
        const record = s.loans.find((l) => l.loanId === params.loanId);
        if (record) record.status = 'active';
      });
      return { hash: result.hash, explorer: result.explorer, loan: await getLoan(client, params.loanId!) };
    },
  },

  {
    method: 'POST',
    path: '/api/loans/:loanId/default',
    summary: 'Default a loan (requires prior impairment + grace)',
    handle: async ({ params }) => {
      const client = await getClient();
      const w = loadWallets();
      const loan = await getLoan(client, params.loanId!);

      // Fail with the actual reason rather than letting tecTOO_SOON come back
      // from the ledger, which says nothing about impairment being the cause.
      if (!loan.impaired) {
        throw new HttpError(409, 'A loan must be impaired before it can be defaulted, or the ledger returns tecTOO_SOON.');
      }
      const { ripple: now } = await validatedCloseTime(client);
      const defaultableAt = loan.nextPaymentDueDate + loan.gracePeriod;
      if (now <= defaultableAt) {
        throw new HttpError(409, `Grace period has not expired — defaultable in ${defaultableAt - now}s.`);
      }

      const result = await defaultLoan(client, w.broker, params.loanId!);
      updateState((s) => {
        const record = s.loans.find((l) => l.loanId === params.loanId);
        if (record) record.status = 'defaulted';
      });
      const { vaultId } = requireVault();
      return {
        hash: result.hash,
        explorer: result.explorer,
        nav: navPayload(computeNav(await getVault(client, vaultId))),
      };
    },
  },
];
