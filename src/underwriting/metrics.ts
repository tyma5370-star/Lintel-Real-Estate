import { interestOnlyAnnualDebtService } from './amortisation';
import { POLICY } from './policy';
import type { DealInput, Metrics } from './types';

/**
 * Income and value metrics.
 *
 * Split into two stages deliberately: the income side of a deal does not depend
 * on the loan, but LTV/DSCR/debt-yield do. Sizing needs the first stage before it
 * can solve for a loan amount, and the second stage is then evaluated at the
 * amount it chose.
 */

export interface IncomeMetrics {
  totalProjectCost: number;
  effectiveGrossIncome: number;
  operatingExpenses: number;
  netOperatingIncome: number;
}

/** Stage one — loan-independent. */
export function incomeMetrics(deal: DealInput): IncomeMetrics {
  const totalProjectCost = deal.purchasePrice + deal.rehabBudget;

  // Effective gross income: stabilised rent net of vacancy and credit loss.
  const effectiveGrossIncome = deal.monthlyGrossRent * (1 - deal.vacancyRate) * 12;

  // Fixed costs are annualised from their monthly figures; variable costs are a
  // share of EGI, which is the convention that keeps them honest when rents move.
  const fixedAnnual = (deal.monthlyTaxes + deal.monthlyInsurance + deal.monthlyHOA) * 12;
  const variableAnnual = effectiveGrossIncome * (deal.maintenanceReserveRate + deal.managementFeeRate);
  const operatingExpenses = fixedAnnual + variableAnnual;

  return {
    totalProjectCost,
    effectiveGrossIncome,
    operatingExpenses,
    netOperatingIncome: effectiveGrossIncome - operatingExpenses,
  };
}

/** Stage two — evaluated at a specific loan amount and rate. */
export function loanMetrics(
  deal: DealInput,
  income: IncomeMetrics,
  loanAmount: number,
  annualRatePercent: number,
): Metrics {
  // Interest-only — see the note on interestOnlyAnnualDebtService.
  const debtService = loanAmount > 0 ? interestOnlyAnnualDebtService(loanAmount, annualRatePercent) : 0;

  // Interest-only means the balance does not amortise, so the payoff at exit is
  // the full loan amount. This is also the reading a credit committee would take.
  const loanPayoff = loanAmount;
  const netSaleProceeds = deal.afterRepairValue * (1 - POLICY.sellingCostRate);

  // Bridge loans fund in two pieces: an advance at close against the as-is value,
  // and a rehab holdback released against completed work. Only the advance is
  // outstanding at close, so as-is LTV is measured against the advance — measuring
  // it against the full commitment would reject every deal that funds a rehab.
  const rehabHoldback = Math.min(deal.rehabBudget, loanAmount);
  const initialAdvance = Math.max(0, loanAmount - rehabHoldback);

  return {
    ...income,
    ltc: loanAmount / income.totalProjectCost,
    ltvAsIs: loanAmount / deal.asIsValue,
    arvLtv: loanAmount / deal.afterRepairValue,
    annualDebtService: debtService,
    dscr: debtService > 0 ? income.netOperatingIncome / debtService : Infinity,
    debtYield: loanAmount > 0 ? income.netOperatingIncome / loanAmount : Infinity,
    exitCoverage: loanPayoff > 0 ? netSaleProceeds / loanPayoff : Infinity,
    equityRequired: Math.max(0, income.totalProjectCost - loanAmount),
    initialAdvance,
    rehabHoldback,
    advanceLtvAsIs: initialAdvance / deal.asIsValue,
  };
}

export function computeMetrics(deal: DealInput, loanAmount: number, annualRatePercent: number): Metrics {
  return loanMetrics(deal, incomeMetrics(deal), loanAmount, annualRatePercent);
}
