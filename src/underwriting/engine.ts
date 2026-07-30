import { interestOnlyAnnualDebtService } from './amortisation';
import { decide, rateForGrade, requiredCoverForGrade } from './grade';
import { incomeMetrics, loanMetrics, type IncomeMetrics } from './metrics';
import { GRADE_TABLE, POLICY } from './policy';
import { sizeLoan } from './size';
import type { DealInput, RealWorldTerms, Sizing, Underwriting } from './types';

/**
 * The underwriting engine.
 *
 * There is a circularity to resolve: the loan amount depends on the rate (via the
 * DSCR constraint), the rate depends on the grade, and the grade depends on
 * metrics computed at the loan amount. Rather than pretend it away by grading off
 * a fixed assumed rate, we iterate to a fixed point — size at the current rate,
 * regrade, reprice, resize — which converges in two or three passes because the
 * grade table is coarse.
 *
 * The loop is capped and its termination condition is grade stability, not
 * numerical tolerance, so it cannot oscillate indefinitely between two adjacent
 * grades without being caught.
 */

const MAX_ITERATIONS = 8;

export function underwrite(deal: DealInput): Underwriting {
  validate(deal);
  const income = incomeMetrics(deal);

  // Open at the mid-grade rate. Nothing depends on this choice except how many
  // passes the loop takes.
  let rate = POLICY.baseRatePercent + GRADE_TABLE.B.spreadPercent;
  let sizing = sizeAt(deal, income, rate);
  let metrics = loanMetrics(deal, income, sizing.loanAmount, rate);
  let decision = decide(deal, metrics, sizing);
  const seen = new Set<string>();

  for (let pass = 0; pass < MAX_ITERATIONS; pass++) {
    const nextRate = rateForGrade(decision.grade);
    if (nextRate === rate) break;

    // Guard against a two-cycle between adjacent grades: if we have already
    // priced at this rate once, stop and keep the more conservative (higher) one.
    const key = `${decision.grade}:${nextRate}`;
    if (seen.has(key)) {
      rate = Math.max(rate, nextRate);
      break;
    }
    seen.add(key);

    rate = nextRate;
    sizing = sizeAt(deal, income, rate);
    metrics = loanMetrics(deal, income, sizing.loanAmount, rate);
    decision = decide(deal, metrics, sizing);
  }

  // Final evaluation at the settled rate.
  sizing = sizeAt(deal, income, rate);
  metrics = loanMetrics(deal, income, sizing.loanAmount, rate);
  decision = decide(deal, metrics, sizing);

  const result: Underwriting = {
    dealId: deal.id,
    address: deal.address,
    metrics,
    sizing,
    decision,
  };

  if (decision.approved) {
    result.terms = buildRealWorldTerms(deal, sizing.loanAmount, rate, decision.grade);
  }

  return result;
}

const sizeAt = (deal: DealInput, income: IncomeMetrics, rate: number): Sizing => sizeLoan(deal, income, rate);

function buildRealWorldTerms(
  deal: DealInput,
  loanAmount: number,
  annualRatePercent: number,
  grade: Parameters<typeof requiredCoverForGrade>[0],
): RealWorldTerms {
  // Interest-only during the term, principal retired at exit. The monthly payment
  // is one month of interest; the balloon is the full principal.
  const monthlyInterest = interestOnlyAnnualDebtService(loanAmount, annualRatePercent) / 12;

  return {
    loanAmount,
    annualRatePercent,
    termMonths: deal.termMonths,
    paymentCount: deal.termMonths,
    monthlyPayment: monthlyInterest,
    balloonAtExit: loanAmount,
    originationFee: loanAmount * POLICY.originationFeeRate,
    servicingFee: loanAmount * POLICY.servicingFeeRate,
    latePaymentFee: monthlyInterest * POLICY.latePaymentFeeRate,
    closePaymentFee: loanAmount * POLICY.closeFeeRate,
    totalInterest: monthlyInterest * deal.termMonths,
    requiredCoverPercent: requiredCoverForGrade(grade),
  };
}

/**
 * Reject incomplete input loudly.
 *
 * Every field on `DealInput` is required by the type, but the engine is also
 * reachable over HTTP where the type guarantees nothing. A missing HOA figure
 * arriving as `undefined` and being coerced to 0 would inflate NOI and pass a
 * deal that should fail, so it is checked here rather than trusted.
 */
export function validate(deal: DealInput): void {
  const required: Array<keyof DealInput> = [
    'purchasePrice',
    'rehabBudget',
    'afterRepairValue',
    'asIsValue',
    'monthlyGrossRent',
    'vacancyRate',
    'monthlyTaxes',
    'monthlyInsurance',
    'monthlyHOA',
    'maintenanceReserveRate',
    'managementFeeRate',
    'termMonths',
    'sponsorLiquidity',
    'sponsorPriorDeals',
  ];

  const missing = required.filter((field) => typeof deal[field] !== 'number' || !Number.isFinite(deal[field] as number));
  if (missing.length > 0) {
    throw new Error(
      `Deal ${deal.id ?? '(unnamed)'} is missing required numeric inputs: ${missing.join(', ')}. ` +
        'Nothing defaults — an unstated assumption is how bad underwriting happens.',
    );
  }

  if (deal.termMonths <= 0) throw new RangeError('termMonths must be greater than zero.');
  if (deal.afterRepairValue <= 0) throw new RangeError('afterRepairValue must be greater than zero.');
  if (deal.asIsValue <= 0) throw new RangeError('asIsValue must be greater than zero.');
  if (deal.vacancyRate < 0 || deal.vacancyRate >= 1) {
    throw new RangeError('vacancyRate is a decimal in [0, 1) — 7% is 0.07, not 7.');
  }
  if (deal.maintenanceReserveRate < 0 || deal.maintenanceReserveRate >= 1) {
    throw new RangeError('maintenanceReserveRate is a decimal in [0, 1).');
  }
  if (deal.managementFeeRate < 0 || deal.managementFeeRate >= 1) {
    throw new RangeError('managementFeeRate is a decimal in [0, 1).');
  }
  if (deal.exitStrategy !== 'refinance' && deal.exitStrategy !== 'sale') {
    throw new RangeError(`exitStrategy must be 'refinance' or 'sale', got '${deal.exitStrategy}'.`);
  }
}
