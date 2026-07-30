/**
 * Amortisation.
 *
 * If the periodic payment is wrong, every downstream number is wrong and the
 * ledger will not tell you — it will accept the loan and quietly amortise on its
 * own arithmetic. This module is unit-tested against a hand-computed schedule
 * (see test/amortisation.test.ts).
 */

export interface ScheduleRow {
  period: number;
  openingBalance: number;
  payment: number;
  interest: number;
  principal: number;
  closingBalance: number;
}

/**
 * Standard level-payment (annuity) formula:
 *
 *     A = P · r / (1 − (1 + r)^−n)
 *
 * where `r` is the rate **per period** and `n` the number of periods.
 * Degenerates gracefully to straight-line when r = 0.
 */
export function periodicPayment(principal: number, ratePerPeriod: number, periods: number): number {
  if (periods <= 0) throw new RangeError(`periodicPayment: periods must be > 0, got ${periods}`);
  if (principal < 0) throw new RangeError(`periodicPayment: principal must be >= 0, got ${principal}`);
  if (ratePerPeriod < 0) throw new RangeError(`periodicPayment: rate must be >= 0, got ${ratePerPeriod}`);
  if (ratePerPeriod === 0) return principal / periods;

  return (principal * ratePerPeriod) / (1 - Math.pow(1 + ratePerPeriod, -periods));
}

/** Full amortisation schedule. The final row's closing balance is forced to zero
 *  so accumulated rounding does not leave a phantom balance. */
export function schedule(principal: number, ratePerPeriod: number, periods: number): ScheduleRow[] {
  const payment = periodicPayment(principal, ratePerPeriod, periods);
  const rows: ScheduleRow[] = [];
  let balance = principal;

  for (let period = 1; period <= periods; period++) {
    const interest = balance * ratePerPeriod;
    const isFinal = period === periods;
    const principalPart = isFinal ? balance : payment - interest;
    const actualPayment = isFinal ? balance + interest : payment;
    const closing = isFinal ? 0 : balance - principalPart;

    rows.push({
      period,
      openingBalance: balance,
      payment: actualPayment,
      interest,
      principal: principalPart,
      closingBalance: closing,
    });
    balance = closing;
  }

  return rows;
}

export function totalInterest(principal: number, ratePerPeriod: number, periods: number): number {
  return schedule(principal, ratePerPeriod, periods).reduce((sum, row) => sum + row.interest, 0);
}

/** Annual debt service for a monthly-amortising loan. */
export function amortisingAnnualDebtService(
  principal: number,
  annualRatePercent: number,
  termMonths: number,
): number {
  const monthlyRate = annualRatePercent / 100 / 12;
  return periodicPayment(principal, monthlyRate, termMonths) * 12;
}

/**
 * The largest loan whose *amortising* annual debt service stays within a budget.
 * Inverts A = P·r / (1 − (1+r)^−n).
 */
export function principalFromAmortisingDebtService(
  maxAnnualDebtService: number,
  annualRatePercent: number,
  termMonths: number,
): number {
  if (maxAnnualDebtService <= 0) return 0;
  const monthlyRate = annualRatePercent / 100 / 12;
  const monthlyPayment = maxAnnualDebtService / 12;

  if (monthlyRate === 0) return monthlyPayment * termMonths;
  return (monthlyPayment * (1 - Math.pow(1 + monthlyRate, -termMonths))) / monthlyRate;
}

/**
 * Annual debt service for an interest-only loan.
 *
 * **This is the one underwriting uses, and the choice matters more than it looks.**
 *
 * Bridge loans are interest-only with the principal retired at exit — refinance or
 * sale. Underwriting DSCR against a fully-amortising schedule over a 12-month term
 * would charge the property with repaying its entire principal out of one year of
 * net operating income, which no property on earth does. It would cap every loan
 * at roughly one year of NOI and make DSCR the binding constraint on all of them,
 * for a reason that has nothing to do with credit.
 *
 * Note the consequence: the loan we *underwrite* is interest-only, but the loan
 * XLS-66 *originates* amortises over `PaymentTotal` payments. The protocol has no
 * interest-only or balloon structure. That gap is disclosed in the README and is
 * an entry in docs/feedback-log.md, because interest-only is the dominant
 * structure in the asset class the protocol is most naturally suited to.
 */
export function interestOnlyAnnualDebtService(principal: number, annualRatePercent: number): number {
  return principal * (annualRatePercent / 100);
}

/** The largest interest-only loan whose annual interest fits inside a budget. */
export function principalFromInterestOnlyDebtService(
  maxAnnualDebtService: number,
  annualRatePercent: number,
): number {
  if (maxAnnualDebtService <= 0 || annualRatePercent <= 0) return 0;
  return maxAnnualDebtService / (annualRatePercent / 100);
}
