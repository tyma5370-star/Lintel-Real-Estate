import { DEAL_NARRATIVE, DEMO_DEALS } from '../demo/deals';
import { toOnChainTerms } from '../underwriting/terms';
import { underwrite } from '../underwriting/engine';
import { GRADE_TABLE } from '../underwriting/policy';
import { banner, fail, heading, info, money, note, ok, pct, table, warn } from './console';

/**
 * Run the underwriting engine over the demo deals. No network, no ledger.
 *
 * This is the fast feedback loop for Phase 2 and it is also the clearest single
 * artefact of what the project actually does: three deals in, a credit decision
 * and a set of XLS-66 terms out, with every number traceable to a line of policy.
 */
function main(): void {
  banner('Bridge — underwriting engine');

  for (const deal of DEMO_DEALS) {
    heading(`${deal.id} · ${deal.address}`);
    note(DEAL_NARRATIVE[deal.id] ?? '');
    console.log('');

    const result = underwrite(deal);
    const m = result.metrics;

    table([
      ['Total project cost', money(m.totalProjectCost)],
      ['After-repair value', money(deal.afterRepairValue)],
      ['Effective gross income', money(m.effectiveGrossIncome)],
      ['Operating expenses', money(m.operatingExpenses)],
      ['Net operating income', money(m.netOperatingIncome)],
    ]);

    console.log('');
    info('Sizing — the loan is the minimum across every constraint:');
    for (const constraint of result.sizing.constraints) {
      const isBinding = constraint.name === result.sizing.bindingConstraint;
      const marker = isBinding ? '→' : ' ';
      console.log(`    ${marker} ${money(constraint.maxLoan).padStart(14)}  ${constraint.description}`);
    }

    console.log('');
    table([
      ['Loan amount', money(result.sizing.loanAmount)],
      ['Binding constraint', result.sizing.bindingConstraint],
      ['LTC', pct(m.ltc)],
      ['ARV-LTV', pct(m.arvLtv)],
      ['Advance at close', `${money(m.initialAdvance)}  (${pct(m.advanceLtvAsIs)} of as-is value)`],
      ['Rehab holdback', money(m.rehabHoldback)],
      ['DSCR', `${m.dscr.toFixed(2)}x`],
      ['Debt yield', pct(m.debtYield)],
      ['Exit coverage', `${m.exitCoverage.toFixed(2)}x`],
      ['Sponsor equity required', money(m.equityRequired)],
    ]);

    console.log('');
    if (result.decision.approved && result.terms) {
      const t = result.terms;
      ok(`APPROVED — grade ${result.decision.grade}: ${GRADE_TABLE[result.decision.grade].label}`);
      table([
        ['Rate', `${t.annualRatePercent.toFixed(2)}% annual, interest-only`],
        ['Term', `${t.termMonths} months`],
        ['Monthly interest', money(t.monthlyPayment)],
        ['Balloon at exit', money(t.balloonAtExit)],
        ['Origination fee', money(t.originationFee)],
        ['Servicing fee / payment', money(t.servicingFee)],
        ['Total interest over term', money(t.totalInterest)],
        ['Required first-loss cover', `${t.requiredCoverPercent}%`],
      ]);

      const onChain = toOnChainTerms(t, deal.address);
      console.log('');
      info('XLS-66 LoanSet fields (rates in 1/10 basis points):');
      table([
        ['PrincipalRequested', onChain.principalRequested],
        ['InterestRate', `${onChain.interestRate}  (${(onChain.interestRate / 1000).toFixed(3)}%)`],
        ['PaymentTotal', String(onChain.paymentTotal)],
        ['PaymentInterval', `${onChain.paymentInterval}s`],
        ['GracePeriod', `${onChain.gracePeriod}s`],
        ['LoanOriginationFee', onChain.loanOriginationFee],
        ['LoanServiceFee', onChain.loanServiceFee],
        ['LatePaymentFee', onChain.latePaymentFee],
        ['ClosePaymentFee', onChain.closePaymentFee],
        ['LateInterestRate', String(onChain.lateInterestRate)],
        ['CloseInterestRate', String(onChain.closeInterestRate)],
        ['OverpaymentFee', String(onChain.overpaymentFee)],
        ['Flags', onChain.allowOverpayment ? 'tfLoanOverpayment' : '0'],
      ]);
      console.log('');
      warn(onChain.compression.note);
      note(`Expected PeriodicPayment: ${money(onChain.compression.expectedPeriodicPayment)}`);
    } else {
      fail(`DECLINED — grade ${result.decision.grade}: ${GRADE_TABLE[result.decision.grade].label}`);
      for (const reason of result.decision.declineReasons) {
        console.log(`      · ${reason}`);
      }
    }
  }

  console.log('');
}

main();
