import type { Client } from 'xrpl';
import { explorerAccount } from '../config';
import { createBroker, DEMO_BROKER_POLICY, depositCover } from '../ledger/broker';
import { withClient } from '../ledger/client';
import { defaultLoan, impairLoan, originateLoan, repayOnSchedule, waitForLedgerTime } from '../ledger/loan';
import { readNav, readPosition, type Nav } from '../ledger/nav';
import { getBroker, getLoan, iouBalance } from '../ledger/read';
import { createVault, depositToVault, type FundIdentity } from '../ledger/vault';
import { loadWallets } from '../ledger/wallets';
import { BOULDER, CLEVELAND, DEAL_NARRATIVE, PUEBLO } from '../demo/deals';
import { policyHash } from '../demo/policy-hash';
import { underwrite } from '../underwriting/engine';
import { GRADE_TABLE } from '../underwriting/policy';
import { toOnChainTerms } from '../underwriting/terms';
import type { Underwriting } from '../underwriting/types';
import { loadState, recordNav, updateState } from '../store';
import { banner, fail, heading, info, money, note, ok, pct, step, table, tx, warn } from './console';

/**
 * The demo. One command, the whole story, narrated.
 *
 * Every step says what is happening in *fund* terms first and protocol terms
 * second, then prints the hash and an explorer link. A judge reading only this
 * console output should understand the product without opening the code.
 */

const FUND_IDENTITY: FundIdentity = {
  name: 'Lintel RE Fund I',
  strategy: 'RE-BRIDGE',
  targetLtvBand: [55, 70],
  policyHash: policyHash().slice(0, 12),
};

const LP_DEPOSIT = 600_000;
const LP2_DEPOSIT = 200_000;
const COVER_DEPOSIT = 120_000;

async function main(): Promise<void> {
  await withClient(async (client) => {
    const w = loadWallets();
    const issuer = w.issuer.classicAddress;

    banner('Lintel — a real-estate bridge lending fund on the XRP Ledger');
    note('Limited partners deposit into an XLS-65 Single Asset Vault. An off-chain');
    note('underwriting engine scores each property deal and outputs loan terms. Those terms');
    note('are originated on-chain through the XLS-66 Lending Protocol, with first-loss');
    note('capital standing in front of the LPs when a borrower defaults.');
    console.log('');
    warn('Devnet only. Server-side keys. Nothing here is production software.');

    if (loadState().vaultId) {
      console.log('');
      fail('A fund is already open. Run `npm run teardown` first.');
      process.exitCode = 1;
      return;
    }

    for (const [role, need] of [['lp', LP_DEPOSIT], ['lp2', LP2_DEPOSIT], ['broker', COVER_DEPOSIT]] as const) {
      if ((await iouBalance(client, w[role].classicAddress, issuer)) < need) {
        fail(`${role} is short of demo USD. Run \`npm run bootstrap\` first.`);
        process.exitCode = 1;
        return;
      }
    }

    // ── Act I — the fund opens ───────────────────────────────────────────
    heading('Act I — the fund opens');

    step(1, 'The manager creates the vault');
    note('A Single Asset Vault denominated in a demo USD stablecoin. The fund\'s identity and a');
    note('hash of its underwriting policy are written into the vault\'s on-ledger Data field, so');
    note('the credit box it claims to run is verifiable against the one it ran.');
    const vault = await createVault(client, w.broker, { issuer, identity: FUND_IDENTITY });
    tx('VaultCreate', vault.submit.hash, vault.submit.explorer);
    info(`Vault pseudo-account: ${explorerAccount(vault.account)}`);
    updateState((s) => {
      s.vaultId = vault.vaultId;
      s.vaultAccount = vault.account;
      s.shareMptId = vault.shareMptId;
      s.vaultScale = vault.scale;
      s.issuer = issuer;
      s.navHistory = [];
      s.deals = [];
    });

    step(2, 'Two limited partners subscribe');
    const d1 = await depositToVault(client, w.lp, vault.vaultId, LP_DEPOSIT, issuer);
    tx(`LP  subscribes ${money(LP_DEPOSIT)}`, d1.hash, d1.explorer);
    const d2 = await depositToVault(client, w.lp2, vault.vaultId, LP2_DEPOSIT, issuer);
    tx(`LP2 subscribes ${money(LP2_DEPOSIT)}`, d2.hash, d2.explorer);

    let nav = await readNav(client, vault.vaultId);
    printNav(nav, 'Fund open');
    recordNav(nav.navPerShare, 'after LP subscriptions');

    step(3, 'The manager registers as a loan broker and posts first-loss capital');
    note('The manager takes the first loss. Below the required cover it cannot originate at all,');
    note('and every fee it earns is diverted into the cover pool until the shortfall is made good.');
    const broker = await createBroker(client, w.broker, vault.vaultId);
    tx('LoanBrokerSet', broker.submit.hash, broker.submit.explorer);
    table([
      ['Management fee', `${DEMO_BROKER_POLICY.managementFeePercent}%`],
      ['First-loss cover minimum', `${DEMO_BROKER_POLICY.coverMinimumPercent}% of outstanding debt`],
      ['Max drawn per default', `${DEMO_BROKER_POLICY.coverLiquidationPercent}% of required cover`],
    ]);
    warn('These three rates are immutable once set. They are a policy decision, made once.');

    const cover = await depositCover(client, w.broker, broker.brokerId, COVER_DEPOSIT, issuer);
    tx(`First-loss capital posted: ${money(COVER_DEPOSIT)}`, cover.hash, cover.explorer);
    updateState((s) => {
      s.brokerId = broker.brokerId;
      s.brokerAccount = broker.account;
    });

    // ── Act II — underwriting ────────────────────────────────────────────
    heading('Act II — three deals cross the desk');
    note('The same engine, the same policy, three different answers. Nothing is hardcoded:');
    note('change one input and the answer changes.');

    const cleveland = describe(CLEVELAND.id, underwrite(CLEVELAND));
    const pueblo = describe(PUEBLO.id, underwrite(PUEBLO));
    const boulder = describe(BOULDER.id, underwrite(BOULDER));

    if (!cleveland.terms || !boulder.terms) throw new Error('Expected Cleveland and Boulder to be approved.');
    if (pueblo.decision.approved) throw new Error('Expected Pueblo to be declined.');

    updateState((s) => {
      s.deals = [
        { dealId: CLEVELAND.id, input: CLEVELAND, underwriting: cleveland },
        { dealId: PUEBLO.id, input: PUEBLO, underwriting: pueblo },
        { dealId: BOULDER.id, input: BOULDER, underwriting: boulder },
      ];
    });

    // ── Act III — the good loan ──────────────────────────────────────────
    heading('Act III — Cleveland performs');

    const cleTerms = toOnChainTerms(cleveland.terms, CLEVELAND.address);
    step(4, 'Originate the Cleveland loan');
    note('LoanSet is dual-signed: the borrower signs, then the manager counter-signs, and the');
    note('combined blob is submitted. Principal moves to the borrower on success — there is no');
    note('separate draw step.');
    printCompression(cleTerms.compression.note);

    const cleLoan = await originateLoan(client, w.borrower, w.broker, broker.brokerId, cleTerms);
    tx(`LoanSet · ${money(cleveland.terms.loanAmount)} to the sponsor`, cleLoan.submit.hash, cleLoan.submit.explorer);
    updateState((s) => {
      s.loans.push({
        loanId: cleLoan.loanId,
        dealId: CLEVELAND.id,
        borrower: w.borrower.classicAddress,
        originationHash: cleLoan.submit.hash,
        underwriting: cleveland,
        onChain: cleTerms,
        status: 'active',
      });
    });

    step(5, 'The sponsor repays on schedule');
    note('Twelve monthly installments. They are prepaid rather than waited out — an early payment');
    note('is an on-time payment, and the interest is fixed at origination, so the economics hold.');
    const payments = await repayOnSchedule(client, w.borrower, cleLoan.loanId, issuer, undefined, (index, _r, result, due) => {
      tx(`Installment ${index}/12 · ${money(Number(due.amount))}`, result.hash, result.explorer);
    });
    ok(`Repaid in full across ${payments.length} installments.`);

    const navAfterRepay = await readNav(client, vault.vaultId);
    printNav(navAfterRepay, 'After Cleveland repaid');

    // Attribute the gain per *share*, not per vault.
    //
    // Subtracting net assets before from after and calling the difference
    // "interest" is wrong the moment anything else moves assets — a deposit
    // arriving mid-run gets reported as earnings, which is precisely the error
    // you least want on screen in front of a judge. NAV per share is immune to
    // subscriptions and redemptions, so the honest figure is the per-share gain
    // applied to the share base that actually earned it.
    const perShareGain = navAfterRepay.navPerShare - nav.navPerShare;
    const interestToLps = perShareGain * nav.sharesOutstandingScaled;
    ok(
      `NAV per share rose ${nav.navPerShare.toFixed(6)} → ${navAfterRepay.navPerShare.toFixed(6)} ` +
        `(+${money(interestToLps)} of interest to the LPs holding at origination).`,
    );

    if (Math.abs(navAfterRepay.sharesOutstandingScaled - nav.sharesOutstandingScaled) > 1e-6) {
      warn(
        `Share count changed during the run (${nav.sharesOutstandingScaled.toLocaleString()} → ` +
          `${navAfterRepay.sharesOutstandingScaled.toLocaleString()}) — someone subscribed or redeemed ` +
          'while the demo was running, so the totals below will not match a clean run.',
      );
    }
    recordNav(navAfterRepay.navPerShare, 'after Cleveland repaid in full');
    nav = navAfterRepay;
    updateState((s) => {
      const record = s.loans.find((l) => l.loanId === cleLoan.loanId);
      if (record) record.status = 'repaid';
    });

    // ── Act IV — the bad loan ────────────────────────────────────────────
    heading('Act IV — Boulder goes wrong');

    const bldTerms = toOnChainTerms(boulder.terms, BOULDER.address);
    step(6, 'Originate the Boulder loan');
    const bldLoan = await originateLoan(client, w.borrower, w.broker, broker.brokerId, bldTerms);
    tx(`LoanSet · ${money(boulder.terms.loanAmount)} to the sponsor`, bldLoan.submit.hash, bldLoan.submit.explorer);
    updateState((s) => {
      s.loans.push({
        loanId: bldLoan.loanId,
        dealId: BOULDER.id,
        borrower: w.borrower.classicAddress,
        originationHash: bldLoan.submit.hash,
        underwriting: boulder,
        onChain: bldTerms,
        status: 'active',
      });
    });

    const navAfterOrigination = await readNav(client, vault.vaultId);
    info(
      `NAV per share ${nav.navPerShare.toFixed(6)} → ${navAfterOrigination.navPerShare.toFixed(6)}: the vault ` +
        `books the loan's ${money(navAfterOrigination.assetsTotal - nav.assetsTotal)} of expected interest ` +
        'as a receivable at origination.',
    );
    recordNav(navAfterOrigination.navPerShare, 'after Boulder originated');

    step(7, 'The sponsor stops communicating — the manager impairs the loan');
    note('Impairment is the protocol\'s watchlist. It pulls the next payment due date forward, so');
    note('the loan can be defaulted a grace period later instead of waiting out the schedule, and');
    note('it reverses itself if the borrower pays. It is also a provision: the vault writes the');
    note('loan down immediately.');

    const beforeImpair = await getLoan(client, bldLoan.loanId);
    const navBeforeImpair = await readNav(client, vault.vaultId);
    const impair = await impairLoan(client, w.broker, bldLoan.loanId);
    tx('LoanManage · tfLoanImpair', impair.hash, impair.explorer);
    updateState((s) => {
      const record = s.loans.find((l) => l.loanId === bldLoan.loanId);
      if (record) record.status = 'impaired';
    });

    const navAfterImpair = await readNav(client, vault.vaultId);
    table([
      ['Unrealized loss provisioned', money(navAfterImpair.lossUnrealized)],
      ['NAV per share', `${navBeforeImpair.navPerShare.toFixed(6)} → ${navAfterImpair.navPerShare.toFixed(6)}`],
    ]);
    recordNav(navAfterImpair.navPerShare, 'after Boulder impaired (provision)');

    step(8, 'The borrower does not cure — the loan defaults');
    const afterImpair = await getLoan(client, bldLoan.loanId);
    const coverBefore = (await getBroker(client, broker.brokerId)).coverAvailable;
    await waitForLedgerTime(client, afterImpair.nextPaymentDueDate + afterImpair.gracePeriod + 1, (remaining) =>
      info(`grace period expires in ${remaining}s…`),
    );

    const defaulted = await defaultLoan(client, w.broker, bldLoan.loanId);
    tx('LoanManage · tfLoanDefault', defaulted.hash, defaulted.explorer);
    updateState((s) => {
      const record = s.loans.find((l) => l.loanId === bldLoan.loanId);
      if (record) record.status = 'defaulted';
    });

    const brokerAfter = await getBroker(client, broker.brokerId);
    const navAfterDefault = await readNav(client, vault.vaultId);
    const byCover = coverBefore - brokerAfter.coverAvailable;
    const byVault = navBeforeImpair.netAssets - navAfterDefault.netAssets;

    heading('Where the loss landed');
    info(`Boulder defaulted owing ${money(beforeImpair.totalValueOutstanding)}.`);
    console.log('');
    table([
      ['First-loss capital absorbed', money(byCover)],
      ['LPs absorbed', money(byVault)],
      ['Manager cover remaining', money(brokerAfter.coverAvailable)],
    ]);
    note(
      `Absorption is capped at the REQUIRED cover — ${DEMO_BROKER_POLICY.coverMinimumPercent}% of outstanding ` +
        `debt — not at cover available. The manager held ${money(coverBefore)}; ${money(byCover)} was drawn.`,
    );

    const lp = await readPosition(client, w.lp.classicAddress, vault.vaultId, navAfterDefault);
    const lp2 = await readPosition(client, w.lp2.classicAddress, vault.vaultId, navAfterDefault);
    console.log('');
    info('The residual falls on both LPs in proportion, not on whoever happened to be holding:');
    table([
      ['LP', `${pct(lp.ownership)} of the fund · position now ${money(lp.value)}`],
      ['LP2', `${pct(lp2.ownership)} of the fund · position now ${money(lp2.value)}`],
    ]);
    recordNav(navAfterDefault.navPerShare, 'after Boulder default (realized)');

    // ── Curtain ──────────────────────────────────────────────────────────
    banner('NAV per share — the whole story in one column');
    for (const point of loadState().navHistory) {
      console.log(`    ${point.navPerShare.toFixed(6)}   ${point.note}`);
    }
    console.log('');
    info('Every figure above was read back from the ledger after the write that caused it.');
    info('Nothing is rendered from local cache. Run `npm run teardown` to clean up.');
  });
}

/** Print an underwriting result the way a credit memo would read. */
function describe(id: string, result: Underwriting): Underwriting {
  console.log('');
  info(`${id} · ${result.address}`);
  note(DEAL_NARRATIVE[id] ?? '');

  const m = result.metrics;
  table([
    ['NOI (stabilised)', money(m.netOperatingIncome)],
    ['Loan sized at', money(result.sizing.loanAmount)],
    ['Bound by', result.sizing.bindingConstraint],
    ['ARV-LTV / LTC', `${pct(m.arvLtv)} / ${pct(m.ltc)}`],
    ['DSCR / debt yield', `${m.dscr.toFixed(2)}x / ${pct(m.debtYield)}`],
    ['Exit coverage', `${m.exitCoverage.toFixed(2)}x`],
  ]);

  if (result.decision.approved && result.terms) {
    ok(
      `APPROVED · grade ${result.decision.grade} · ${result.terms.annualRatePercent.toFixed(2)}% ` +
        `interest-only · ${GRADE_TABLE[result.decision.grade].label}`,
    );
  } else {
    fail(`DECLINED · grade ${result.decision.grade}`);
    for (const reason of result.decision.declineReasons) console.log(`      · ${reason}`);
  }
  return result;
}

function printNav(nav: Nav, label: string): void {
  table([
    [`${label} — assets`, money(nav.assetsTotal)],
    ['Available to lend', money(nav.assetsAvailable)],
    ['Unrealized loss', money(nav.lossUnrealized)],
    ['Shares outstanding', nav.sharesOutstandingScaled.toLocaleString('en-US')],
    ['NAV per share', nav.navPerShare.toFixed(6)],
    ['Deposit / redemption rate', `${nav.depositRatePerShare.toFixed(6)} / ${nav.redemptionRatePerShare.toFixed(6)}`],
  ]);
}

function printCompression(text: string): void {
  console.log('');
  warn(text);
  console.log('');
}

main().catch((error) => {
  console.error('');
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
