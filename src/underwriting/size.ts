import { principalFromInterestOnlyDebtService } from './amortisation';
import type { IncomeMetrics } from './metrics';
import { POLICY } from './policy';
import type { DealInput, Sizing, SizingConstraint } from './types';

/**
 * Loan sizing.
 *
 * A bridge lender sizes to the *tightest* constraint, not to the headline LTV.
 * Each constraint below is solved for a maximum principal independently, and the
 * loan is the minimum of them. Recording which one bound is as important as the
 * amount itself: it is the sentence the borrower actually needs to hear, and on a
 * decline it is the only useful thing you can tell them.
 */

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (value: number) =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function sizeLoan(deal: DealInput, income: IncomeMetrics, annualRatePercent: number): Sizing {
  const constraints: SizingConstraint[] = [];

  // ── Value constraints ────────────────────────────────────────────────────
  constraints.push({
    name: 'arvLtv',
    maxLoan: deal.afterRepairValue * POLICY.maxArvLtv,
    description: `ARV-LTV capped at ${pct(POLICY.maxArvLtv)} of ${usd(deal.afterRepairValue)} ARV = ${usd(
      deal.afterRepairValue * POLICY.maxArvLtv,
    )}`,
  });

  constraints.push({
    name: 'ltc',
    maxLoan: income.totalProjectCost * POLICY.maxLtc,
    description: `LTC capped at ${pct(POLICY.maxLtc)} of ${usd(income.totalProjectCost)} total project cost = ${usd(
      income.totalProjectCost * POLICY.maxLtc,
    )}`,
  });

  // The advance funded at close is constrained by the as-is value; the rehab
  // holdback sits behind completed work and is not outstanding yet. So the
  // commitment this permits is (as-is value x max LTV) + the holdback.
  const asIsAdvanceMax = deal.asIsValue * POLICY.maxLtvAsIs + deal.rehabBudget;
  constraints.push({
    name: 'asIsAdvance',
    maxLoan: asIsAdvanceMax,
    description: `Advance at close capped at ${pct(POLICY.maxLtvAsIs)} of ${usd(
      deal.asIsValue,
    )} as-is value, plus a ${usd(deal.rehabBudget)} rehab holdback = ${usd(asIsAdvanceMax)}`,
  });

  // ── Cash-flow constraint ─────────────────────────────────────────────────
  // Solved for principal rather than tested: the largest interest-only loan whose
  // annual interest is still covered minDscr times over by NOI.
  const maxDebtService = income.netOperatingIncome / POLICY.minDscr;
  const dscrMaxLoan = Math.max(0, principalFromInterestOnlyDebtService(maxDebtService, annualRatePercent));
  constraints.push({
    name: 'dscr',
    maxLoan: dscrMaxLoan,
    description: `DSCR floor of ${POLICY.minDscr.toFixed(2)}x on ${usd(
      income.netOperatingIncome,
    )} NOI supports ${usd(maxDebtService)} of annual interest = ${usd(dscrMaxLoan)} at ${annualRatePercent.toFixed(
      2,
    )}% interest-only`,
  });

  // ── Debt yield ───────────────────────────────────────────────────────────
  const debtYieldMaxLoan = income.netOperatingIncome / POLICY.minDebtYield;
  constraints.push({
    name: 'debtYield',
    maxLoan: Math.max(0, debtYieldMaxLoan),
    description: `Debt-yield floor of ${pct(POLICY.minDebtYield)} on ${usd(
      income.netOperatingIncome,
    )} NOI = ${usd(debtYieldMaxLoan)}`,
  });

  // ── Exit coverage ────────────────────────────────────────────────────────
  const netProceeds = deal.afterRepairValue * (1 - POLICY.sellingCostRate);
  const exitMaxLoan = netProceeds / POLICY.minExitCoverage;
  constraints.push({
    name: 'exitCoverage',
    maxLoan: Math.max(0, exitMaxLoan),
    description: `Exit coverage of ${POLICY.minExitCoverage.toFixed(2)}x on ${usd(
      netProceeds,
    )} net sale proceeds (ARV less ${pct(POLICY.sellingCostRate)} costs) = ${usd(exitMaxLoan)}`,
  });

  const binding = constraints.reduce((tightest, candidate) =>
    candidate.maxLoan < tightest.maxLoan ? candidate : tightest,
  );

  return {
    // Round down to whole currency units — never size up into a constraint.
    loanAmount: Math.floor(Math.max(0, binding.maxLoan)),
    bindingConstraint: binding.name,
    constraints,
  };
}
