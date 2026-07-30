import type { Client } from 'xrpl';
import { SECONDS_PER_YEAR } from '../config';
import { createBroker, DEMO_BROKER_POLICY, depositCover } from '../ledger/broker';
import { withClient } from '../ledger/client';
import {
  defaultLoan,
  impairLoan,
  originateLoan,
  repayOnSchedule,
  waitForLedgerTime,
} from '../ledger/loan';
import { computeNav, readNav, readPosition } from '../ledger/nav';
import { getBroker, getLoan, getVault, iouBalance, validatedCloseTime } from '../ledger/read';
import { createVault, depositToVault, type FundIdentity } from '../ledger/vault';
import { loadWallets } from '../ledger/wallets';
import { policyHash } from '../demo/policy-hash';
import { BOULDER, CLEVELAND } from '../demo/deals';
import { periodicPayment } from '../underwriting/amortisation';
import { underwrite } from '../underwriting/engine';
import { toOnChainTerms } from '../underwriting/terms';
import { loadState, recordNav, updateState } from '../store';
import { banner, fail, heading, info, money, note, ok, step, table, tx, warn } from './console';

/**
 * GATE 1 — the full ledger lifecycle in one command.
 *
 * create -> deposit x2 -> broker -> cover -> originate -> repay
 *        -> originate -> impair -> default
 *
 * Until this runs clean end to end there is no project. It is deliberately a flat
 * sequence of small steps with a hash printed for each, not an abstraction.
 *
 * Run `npm run teardown` between attempts.
 */

const FUND_IDENTITY: FundIdentity = {
  name: 'Lintel RE Fund I',
  strategy: 'RE-BRIDGE',
  targetLtvBand: [55, 70],
  policyHash: policyHash().slice(0, 12),
};

const COVER_DEPOSIT = 120_000;
const LP_DEPOSIT = 600_000;
const LP2_DEPOSIT = 200_000;

async function main(): Promise<void> {
  await withClient(async (client) => {
    const w = loadWallets();
    const issuer = w.issuer.classicAddress;
    banner('Lintel — XRPL lending lifecycle (GATE 1)');

    const existing = loadState();
    if (existing.vaultId) {
      fail(`A vault is already recorded (${existing.vaultId}). Run \`npm run teardown\` first.`);
      process.exitCode = 1;
      return;
    }

    // Pre-flight. A previous run leaves the LPs down by whatever the default cost
    // them, so check solvency before creating a vault rather than after — failing
    // at step 2 strands an empty vault that then has to be torn down.
    const required: Array<[string, number]> = [
      ['lp', LP_DEPOSIT],
      ['lp2', LP2_DEPOSIT],
      ['broker', COVER_DEPOSIT],
    ];
    const short: string[] = [];
    for (const [role, need] of required) {
      const held = await iouBalance(client, w[role as 'lp'].classicAddress, issuer);
      if (held < need) short.push(`${role} holds ${money(held)} but needs ${money(need)}`);
    }
    if (short.length > 0) {
      fail('Insufficient demo USD to run the lifecycle:');
      for (const line of short) info(line);
      info('Run `npm run bootstrap` — it tops every participant back up to its target balance.');
      process.exitCode = 1;
      return;
    }

    // ── 1. VaultCreate ───────────────────────────────────────────────────
    step(1, 'VaultCreate — open the fund');
    note('A Single Asset Vault denominated in our demo USD IOU. Public, first-come-first-serve');
    note('withdrawals, and a fund identity written into the on-ledger Data field.');
    const vault = await createVault(client, w.broker, { issuer, identity: FUND_IDENTITY });
    tx('VaultCreate', vault.submit.hash, vault.submit.explorer);
    table([
      ['Vault ID', vault.vaultId],
      ['Pseudo-account', vault.account],
      ['Share MPT ID', vault.shareMptId],
      ['Scale', String(vault.scale)],
    ]);
    updateState((s) => {
      s.vaultId = vault.vaultId;
      s.vaultAccount = vault.account;
      s.shareMptId = vault.shareMptId;
      s.vaultScale = vault.scale;
      s.issuer = issuer;
      // This is a brand new fund, so the NAV series starts here. Teardown leaves
      // the history in place; without this, a re-run appends to the previous
      // fund's curve and the summary reads as one continuous fund.
      s.navHistory = [];
      s.deals = [];
    });

    // ── 2. LP deposits ───────────────────────────────────────────────────
    step(2, 'VaultDeposit — two limited partners subscribe');
    note('Two LPs, not one: a default has to be shown landing on both proportionally.');

    const lpDeposit = await depositToVault(client, w.lp, vault.vaultId, LP_DEPOSIT, issuer);
    tx(`LP deposits ${money(LP_DEPOSIT)}`, lpDeposit.hash, lpDeposit.explorer);

    const lp2Deposit = await depositToVault(client, w.lp2, vault.vaultId, LP2_DEPOSIT, issuer);
    tx(`LP2 deposits ${money(LP2_DEPOSIT)}`, lp2Deposit.hash, lp2Deposit.explorer);

    let nav = await readNav(client, vault.vaultId);
    const expectedShares = BigInt(Math.round((LP_DEPOSIT + LP2_DEPOSIT) * 10 ** vault.scale));
    table([
      ['Assets total', money(nav.assetsTotal)],
      ['Assets available', money(nav.assetsAvailable)],
      ['Shares outstanding', nav.sharesOutstanding.toString()],
      ['Expected (assets x 10^Scale)', expectedShares.toString()],
      ['NAV per share', nav.navPerShare.toFixed(6)],
    ]);
    if (nav.sharesOutstanding === expectedShares) {
      ok('Initial share mint matches assets x 10^Scale exactly.');
    } else {
      warn(
        `Share mint differs from assets x 10^Scale by ${
          nav.sharesOutstanding - expectedShares
        }. Worth a feedback-log entry.`,
      );
    }
    recordNav(nav.navPerShare, 'after LP subscriptions');

    // ── 3. LoanBrokerSet ─────────────────────────────────────────────────
    step(3, 'LoanBrokerSet — register the fund manager against the vault');
    warn('ManagementFeeRate, CoverRateMinimum and CoverRateLiquidation are IMMUTABLE after this.');
    table([
      ['Management fee', `${DEMO_BROKER_POLICY.managementFeePercent}%`],
      ['Cover minimum', `${DEMO_BROKER_POLICY.coverMinimumPercent}% of outstanding debt`],
      ['Cover liquidation', `${DEMO_BROKER_POLICY.coverLiquidationPercent}% of required cover per default`],
      ['Debt maximum', money(DEMO_BROKER_POLICY.debtMaximum)],
    ]);
    const broker = await createBroker(client, w.broker, vault.vaultId);
    tx('LoanBrokerSet', broker.submit.hash, broker.submit.explorer);
    info(`Broker ID: ${broker.brokerId}`);
    updateState((s) => {
      s.brokerId = broker.brokerId;
      s.brokerAccount = broker.account;
    });

    // ── 4. Cover deposit ─────────────────────────────────────────────────
    step(4, 'LoanBrokerCoverDeposit — post first-loss capital');
    note('Below the required minimum the broker cannot originate at all, and every fee it earns');
    note('is diverted into the cover pool instead of being paid out. So we post well above it.');
    const cover = await depositCover(client, w.broker, broker.brokerId, COVER_DEPOSIT, issuer);
    tx(`Cover deposit ${money(COVER_DEPOSIT)}`, cover.hash, cover.explorer);

    let brokerView = await getBroker(client, broker.brokerId);
    table([
      ['Cover available', money(brokerView.coverAvailable)],
      ['Debt outstanding', money(brokerView.debtTotal)],
      ['Cover required', money(brokerView.coverRequired)],
      ['Origination', brokerView.originationBlocked ? 'BLOCKED' : 'permitted'],
    ]);

    // ── 5. Originate loan 1 (Cleveland) ──────────────────────────────────
    step(5, 'LoanSet — originate the Cleveland loan (dual-signed)');
    const cleveland = underwrite(CLEVELAND);
    if (!cleveland.terms) throw new Error('Cleveland should underwrite as approved.');
    const cleTerms = toOnChainTerms(cleveland.terms, CLEVELAND.address);

    note(`Grade ${cleveland.decision.grade} · ${money(cleveland.terms.loanAmount)} at ` +
      `${cleveland.terms.annualRatePercent.toFixed(2)}% · binding constraint: ${cleveland.sizing.bindingConstraint}`);
    warn(cleTerms.compression.note);

    const borrowerBefore = await iouBalance(client, w.borrower.classicAddress, issuer);
    const cleLoan = await originateLoan(client, w.borrower, w.broker, broker.brokerId, cleTerms);
    tx('LoanSet (borrower signs, broker counter-signs)', cleLoan.submit.hash, cleLoan.submit.explorer);
    const borrowerAfter = await iouBalance(client, w.borrower.classicAddress, issuer);

    const advanced = borrowerAfter - borrowerBefore;
    const expectedAdvance = cleveland.terms.loanAmount - cleveland.terms.originationFee;
    table([
      ['Loan ID', cleLoan.loanId],
      ['Borrower balance before', money(borrowerBefore)],
      ['Borrower balance after', money(borrowerAfter)],
      ['Net advanced', money(advanced)],
      ['Expected (principal - orig fee)', money(expectedAdvance)],
    ]);
    if (Math.abs(advanced - expectedAdvance) < 0.01) {
      ok('GATE 1a PASSED — principal net of origination fee landed with the borrower.');
    } else {
      warn(`Advance differs from expectation by ${money(advanced - expectedAdvance)} — investigate.`);
    }

    updateState((s) => {
      s.deals.push({ dealId: CLEVELAND.id, input: CLEVELAND, underwriting: cleveland });
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

    // ── 5b. The interest-rate basis probe ────────────────────────────────
    heading('PROBE — how does the ledger read InterestRate?');
    await probeInterestRateBasis(client, cleLoan.loanId, cleTerms);

    // ── 6. Repay loan 1 on schedule ──────────────────────────────────────
    step(6, 'LoanPay — Cleveland repays on schedule');
    note('Installments are paid ahead of their due dates, which keeps them on-time: no late flag,');
    note('no late fee. The loan is re-read between payments because PeriodicPayment moves.');
    const payments = await repayOnSchedule(
      client,
      w.borrower,
      cleLoan.loanId,
      issuer,
      undefined,
      (index, remaining, result, due) => {
        tx(
          `Payment ${index} · ${money(Number(due.amount))} (${remaining} remaining before this)`,
          result.hash,
          result.explorer,
        );
      },
    );
    ok(`Cleveland fully repaid in ${payments.length} payments.`);

    const navAfterRepay = await readNav(client, vault.vaultId);
    table([
      ['NAV per share before', nav.navPerShare.toFixed(6)],
      ['NAV per share after', navAfterRepay.navPerShare.toFixed(6)],
      ['Change', (navAfterRepay.navPerShare - nav.navPerShare).toFixed(6)],
      ['Assets total', money(navAfterRepay.assetsTotal)],
    ]);
    if (navAfterRepay.navPerShare > nav.navPerShare) {
      ok('NAV per share ROSE — interest earned has accrued to the LPs.');
    } else {
      warn('NAV per share did not rise on repayment. Check where the interest went.');
    }
    recordNav(navAfterRepay.navPerShare, 'after Cleveland repaid in full');
    nav = navAfterRepay;
    updateState((s) => {
      const record = s.loans.find((l) => l.loanId === cleLoan.loanId);
      if (record) record.status = 'repaid';
    });

    // ── 7. Originate loan 2 (Boulder) ────────────────────────────────────
    step(7, 'LoanSet — originate the Boulder loan (dual-signed)');
    const boulder = underwrite(BOULDER);
    if (!boulder.terms) throw new Error('Boulder should underwrite as approved.');
    const bldTerms = toOnChainTerms(boulder.terms, BOULDER.address);
    note(`Grade ${boulder.decision.grade} · ${money(boulder.terms.loanAmount)} at ` +
      `${boulder.terms.annualRatePercent.toFixed(2)}% · binding constraint: ${boulder.sizing.bindingConstraint}`);

    const bldLoan = await originateLoan(client, w.borrower, w.broker, broker.brokerId, bldTerms);
    tx('LoanSet · Boulder', bldLoan.submit.hash, bldLoan.submit.explorer);
    info(`Loan ID: ${bldLoan.loanId}`);

    updateState((s) => {
      s.deals.push({ dealId: BOULDER.id, input: BOULDER, underwriting: boulder });
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

    brokerView = await getBroker(client, broker.brokerId);
    table([
      ['Debt outstanding', money(brokerView.debtTotal)],
      ['Cover required (10%)', money(brokerView.coverRequired)],
      ['Cover available', money(brokerView.coverAvailable)],
      ['Cover ratio', `${brokerView.coverRatio.toFixed(2)}x`],
    ]);

    // Origination itself moves NAV, which is not obvious: the vault books the
    // loan's full expected interest as an asset the moment the loan is written,
    // rather than accruing it over the term.
    const navAfterOrigination = await readNav(client, vault.vaultId);
    console.log('');
    info('NAV moves on origination — the vault recognises expected interest up front:');
    table([
      ['NAV per share before', nav.navPerShare.toFixed(6)],
      ['NAV per share after', navAfterOrigination.navPerShare.toFixed(6)],
      ['Assets total', money(navAfterOrigination.assetsTotal)],
      ['Expected interest booked', money(navAfterOrigination.assetsTotal - nav.assetsTotal)],
    ]);
    note('Not cash — a receivable. It is exactly this that impairment writes back off.');
    recordNav(navAfterOrigination.navPerShare, 'after Boulder originated (interest booked)');

    // ── 8. Impair ────────────────────────────────────────────────────────
    step(8, 'LoanManage tfLoanImpair — the borrower goes quiet');
    note('Impairment pulls NextPaymentDueDate forward to now, so the loan becomes defaultable one');
    note('grace period later instead of waiting out the schedule. It clears itself if the borrower');
    note('pays before that date — the protocol\'s watchlist, and it is reversible.');

    const beforeImpair = await getLoan(client, bldLoan.loanId);
    const navBeforeImpair = await readNav(client, vault.vaultId);

    const impair = await impairLoan(client, w.broker, bldLoan.loanId);
    tx('LoanManage (impair)', impair.hash, impair.explorer);

    const afterImpair = await getLoan(client, bldLoan.loanId);
    const navAfterImpair = await readNav(client, vault.vaultId);
    table([
      ['Impaired flag', afterImpair.impaired ? 'set' : 'NOT SET'],
      ['Next payment due (before)', String(beforeImpair.nextPaymentDueDate)],
      ['Next payment due (after)', String(afterImpair.nextPaymentDueDate)],
      ['Pulled forward by', `${beforeImpair.nextPaymentDueDate - afterImpair.nextPaymentDueDate}s`],
      ['Grace period', `${afterImpair.gracePeriod}s`],
    ]);

    console.log('');
    info('Impairment is a mark-down, not just a label — the vault provisions immediately:');
    table([
      ['LossUnrealized before', money(navBeforeImpair.lossUnrealized)],
      ['LossUnrealized after', money(navAfterImpair.lossUnrealized)],
      ['Assets total (unchanged)', money(navAfterImpair.assetsTotal)],
      ['NAV per share before', navBeforeImpair.navPerShare.toFixed(6)],
      ['NAV per share after', navAfterImpair.navPerShare.toFixed(6)],
    ]);
    note(
      'The full outstanding balance is written down as unrealized loss the moment the loan is',
    );
    note(
      'impaired. Nothing has actually been lost yet — this is a provision, and unimpairing reverses it.',
    );
    recordNav(navAfterImpair.navPerShare, 'after Boulder impaired (provision)');
    updateState((s) => {
      const record = s.loans.find((l) => l.loanId === bldLoan.loanId);
      if (record) record.status = 'impaired';
    });

    // ── 9. Default ───────────────────────────────────────────────────────
    step(9, 'LoanManage tfLoanDefault — wait out the grace period, then default');
    const defaultableAt = afterImpair.nextPaymentDueDate + afterImpair.gracePeriod;
    const { ripple: nowRipple } = await validatedCloseTime(client);
    info(`Defaultable at ledger time ${defaultableAt}; now ${nowRipple} (${defaultableAt - nowRipple}s to wait).`);
    await waitForLedgerTime(client, defaultableAt + 1, (remaining) =>
      info(`waiting ${remaining}s for the grace period to expire…`),
    );

    const navBeforeDefault = await readNav(client, vault.vaultId);
    const coverBeforeDefault = (await getBroker(client, broker.brokerId)).coverAvailable;

    const defaulted = await defaultLoan(client, w.broker, bldLoan.loanId);
    tx('LoanManage (default)', defaulted.hash, defaulted.explorer);

    const brokerAfterDefault = await getBroker(client, broker.brokerId);
    const navAfterDefault = await readNav(client, vault.vaultId);

    const absorbedByCover = coverBeforeDefault - brokerAfterDefault.coverAvailable;
    // Measured, not derived: the LPs' share of the loss is the fall in the vault's
    // net assets across the episode. Deriving it from TotalValueOutstanding is off
    // by the accrued service fees.
    const absorbedByVault = navBeforeImpair.netAssets - navAfterDefault.netAssets;
    const outstandingAtDefault = beforeImpair.totalValueOutstanding;

    heading('The money shot — where the loss landed');
    info(`Boulder defaulted owing ${money(outstandingAtDefault)}. That loss is split:`);
    console.log('');
    table([
      ['Cover before default', money(coverBeforeDefault)],
      ['Cover after default', money(brokerAfterDefault.coverAvailable)],
      ['→ absorbed by first-loss capital', money(absorbedByCover)],
      ['→ absorbed by the vault (LPs)', money(absorbedByVault)],
    ]);
    note(
      `First-loss absorption is capped at the REQUIRED cover — ${
        DEMO_BROKER_POLICY.coverMinimumPercent
      }% of outstanding debt — not at the cover available.`,
    );
    note(
      `The broker held ${money(coverBeforeDefault)} but only ${money(absorbedByCover)} could be drawn.`,
    );

    console.log('');
    info('NAV per share across the whole episode:');
    table([
      ['Before impairment', navBeforeImpair.navPerShare.toFixed(6)],
      ['After impairment (provisioned)', navAfterImpair.navPerShare.toFixed(6)],
      ['After default (realized)', navAfterDefault.navPerShare.toFixed(6)],
      ['LossUnrealized now', money(navAfterDefault.lossUnrealized)],
      ['Net change from the default', (navAfterDefault.navPerShare - navBeforeImpair.navPerShare).toFixed(6)],
    ]);
    note('NAV recovers slightly on default because the provision assumed a total loss, and');
    note('first-loss capital then reimbursed part of it. The provision was deliberately conservative.');

    const lpPosition = await readPosition(client, w.lp.classicAddress, vault.vaultId, navAfterDefault);
    const lp2Position = await readPosition(client, w.lp2.classicAddress, vault.vaultId, navAfterDefault);
    console.log('');
    info('Both LPs share the residual loss in proportion to their holdings:');
    table([
      ['LP  ownership', `${(lpPosition.ownership * 100).toFixed(2)}%  value ${money(lpPosition.value)}`],
      ['LP2 ownership', `${(lp2Position.ownership * 100).toFixed(2)}%  value ${money(lp2Position.value)}`],
    ]);

    if (absorbedByVault > 0 && navAfterDefault.navPerShare < navBeforeImpair.navPerShare) {
      ok(
        `NAV per share FELL from ${navBeforeImpair.navPerShare.toFixed(6)} to ${navAfterDefault.navPerShare.toFixed(
          6,
        )} — the residual loss reached the LPs, exactly as the structure intends.`,
      );
    } else if (absorbedByCover >= outstandingAtDefault - 0.01) {
      ok('First-loss capital absorbed the entire default — LP NAV was fully protected.');
    } else {
      warn('Loss attribution did not move NAV as expected — check the figures above.');
    }
    recordNav(navAfterDefault.navPerShare, 'after Boulder default (realized)');

    updateState((s) => {
      const record = s.loans.find((l) => l.loanId === bldLoan.loanId);
      if (record) record.status = 'defaulted';
    });

    // ── Summary ──────────────────────────────────────────────────────────
    banner('GATE 1 PASSED');
    const history = loadState().navHistory;
    info('NAV per share over the fund\'s life:');
    for (const point of history) {
      console.log(`    ${point.navPerShare.toFixed(6)}  ${point.note}`);
    }
    console.log('');
    info('Run `npm run teardown` to clean up, then `npm run demo` for the narrated version.');
  });
}

/**
 * Determine empirically how the ledger interprets `InterestRate`.
 *
 * We submitted a rate assuming it applies once per `PaymentInterval`. If the
 * ledger instead treats it as annualised and prorates it by
 * `PaymentInterval / year`, the periodic payment it computes will be far lower
 * than ours. Comparing the ledger's own `PeriodicPayment` against both hypotheses
 * settles it in one observation, which beats reading the amount off a spec and
 * hoping.
 */
async function probeInterestRateBasis(
  client: Client,
  loanId: string,
  terms: { interestRate: number; paymentTotal: number; paymentInterval: number; principalRequested: string },
): Promise<void> {
  const loan = await getLoan(client, loanId);
  const principal = Number(terms.principalRequested);
  const ratePerPeriod = terms.interestRate / 100_000;

  const perPeriodHypothesis = periodicPayment(principal, ratePerPeriod, terms.paymentTotal);
  const annualRatePerPeriod = ratePerPeriod * (terms.paymentInterval / SECONDS_PER_YEAR);
  const annualHypothesis = periodicPayment(principal, annualRatePerPeriod, terms.paymentTotal);

  const observed = loan.periodicPayment;
  const perPeriodError = Math.abs(observed - perPeriodHypothesis);
  const annualError = Math.abs(observed - annualHypothesis);

  table([
    ['Submitted InterestRate', `${terms.interestRate} tenth-bps (${(terms.interestRate / 1000).toFixed(3)}%)`],
    ['PaymentInterval', `${terms.paymentInterval}s`],
    ['Ledger PeriodicPayment', money(observed)],
    ['If rate is per-period', `${money(perPeriodHypothesis)}   (error ${money(perPeriodError)})`],
    ['If rate is annualised', `${money(annualHypothesis)}   (error ${money(annualError)})`],
    ['Ledger LoanScale', String((loan as unknown as { loanScale?: number }).loanScale ?? 'absent')],
  ]);

  const tolerance = Math.max(1, principal * 0.001);
  let basis: 'per-period' | 'annual' | 'inconclusive';

  if (perPeriodError < tolerance && perPeriodError < annualError) {
    basis = 'per-period';
    ok('InterestRate is applied PER PAYMENT PERIOD. config.ts INTEREST_RATE_BASIS=\'per-period\' is correct.');
  } else if (annualError < tolerance) {
    basis = 'annual';
    warn(
      'InterestRate is ANNUALISED and prorated by PaymentInterval. Set INTEREST_RATE_BASIS=\'annual\' ' +
        'in config.ts (or the env var) and re-run — every loan originated so far is under-charging interest.',
    );
  } else {
    basis = 'inconclusive';
    warn(
      `Neither hypothesis matches within ${money(tolerance)}. The ledger uses a different day-count or ` +
        'rounding convention. Record the observed figure in docs/verified.md and derive it from these numbers.',
    );
  }

  updateState((s) => {
    s.interestRateBasis = basis;
  });
  note('Record this result in docs/verified.md.');
}

main().catch((error) => {
  console.error('');
  fail(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
});
