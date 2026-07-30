import { APPROVABLE_GRADES, GRADE_TABLE, GRADE_THRESHOLDS, POLICY } from './policy';
import type { Decision, DealInput, Grade, Metrics, Sizing } from './types';

/**
 * Grading and the approve/decline decision.
 *
 * Grade is assigned from the four things that actually predict loss on a bridge
 * loan: coverage (DSCR), leverage against the exit (ARV-LTV), sponsor track
 * record, and post-close liquidity. The first threshold row satisfied on every
 * dimension wins; anything that clears none of them is a D and is declined.
 */

/** Sponsor liquidity expressed in months of debt service. */
export function liquidityMonths(deal: DealInput, metrics: Metrics): number {
  const monthlyDebtService = metrics.annualDebtService / 12;
  if (monthlyDebtService <= 0) return Infinity;
  return deal.sponsorLiquidity / monthlyDebtService;
}

export function assignGrade(deal: DealInput, metrics: Metrics): Grade {
  const months = liquidityMonths(deal, metrics);

  for (const row of GRADE_THRESHOLDS) {
    if (
      metrics.dscr >= row.minDscr &&
      metrics.arvLtv <= row.maxArvLtv &&
      deal.sponsorPriorDeals >= row.minPriorDeals &&
      months >= row.minLiquidityMonths
    ) {
      return row.grade;
    }
  }
  return 'D';
}

/**
 * Decide the deal.
 *
 * A decline is not a failure of the engine — it is the engine working. Each
 * decline carries the specific policy line it failed, because "computer says no"
 * is not underwriting.
 */
export function decide(deal: DealInput, metrics: Metrics, sizing: Sizing): Decision {
  const grade = assignGrade(deal, metrics);
  const reasons: string[] = [];
  const months = liquidityMonths(deal, metrics);

  if (sizing.loanAmount <= 0) {
    reasons.push('No loan amount clears the credit box — the binding constraint permits zero proceeds.');
  }

  // Proceeds adequacy. Unlike the ratio floors below, this one can actually fail
  // on a sized loan: sizing satisfies the floors *by shrinking the loan*, and
  // shrinking the loan is precisely what breaks proceeds adequacy.
  if (metrics.ltc < POLICY.minViableLtc) {
    const constraint = sizing.constraints.find((c) => c.name === sizing.bindingConstraint);
    reasons.push(
      `Proceeds inadequate: the ${sizing.bindingConstraint} constraint caps the loan at ` +
        `${(metrics.ltc * 100).toFixed(1)}% LTC, below the ${(POLICY.minViableLtc * 100).toFixed(
          0,
        )}% minimum. The sponsor would need to fund $${Math.round(
          metrics.equityRequired,
        ).toLocaleString('en-US')} of a $${Math.round(metrics.totalProjectCost).toLocaleString(
          'en-US',
        )} project. Binding constraint: ${constraint?.description ?? sizing.bindingConstraint}.`,
    );
  }
  if (metrics.dscr < POLICY.minDscr) {
    reasons.push(
      `Stabilised DSCR of ${metrics.dscr.toFixed(2)}x is below the ${POLICY.minDscr.toFixed(2)}x policy floor.`,
    );
  }
  if (metrics.arvLtv > POLICY.maxArvLtv + 1e-9) {
    reasons.push(
      `ARV-LTV of ${(metrics.arvLtv * 100).toFixed(1)}% exceeds the ${(POLICY.maxArvLtv * 100).toFixed(
        1,
      )}% policy maximum.`,
    );
  }
  if (metrics.ltc > POLICY.maxLtc + 1e-9) {
    reasons.push(
      `LTC of ${(metrics.ltc * 100).toFixed(1)}% exceeds the ${(POLICY.maxLtc * 100).toFixed(1)}% policy maximum.`,
    );
  }
  if (metrics.debtYield < POLICY.minDebtYield) {
    reasons.push(
      `Debt yield of ${(metrics.debtYield * 100).toFixed(1)}% is below the ${(
        POLICY.minDebtYield * 100
      ).toFixed(1)}% floor.`,
    );
  }
  if (metrics.exitCoverage < POLICY.minExitCoverage) {
    reasons.push(
      `Exit coverage of ${metrics.exitCoverage.toFixed(2)}x is below the ${POLICY.minExitCoverage.toFixed(
        2,
      )}x floor — the sale does not reliably retire the loan.`,
    );
  }
  if (months < POLICY.minLiquidityMonths) {
    reasons.push(
      `Sponsor liquidity covers ${months.toFixed(1)} months of debt service, against a ${
        POLICY.minLiquidityMonths
      }-month requirement.`,
    );
  }
  if (!APPROVABLE_GRADES.includes(grade)) {
    reasons.push(`Grade ${grade} — ${GRADE_TABLE[grade].label}.`);
  }

  return {
    approved: reasons.length === 0,
    grade,
    declineReasons: reasons,
    bindingConstraint: sizing.bindingConstraint,
  };
}

/** Note rate for a grade: base rate plus the grade spread. */
export function rateForGrade(grade: Grade): number {
  return POLICY.baseRatePercent + GRADE_TABLE[grade].spreadPercent;
}

export function requiredCoverForGrade(grade: Grade): number {
  return GRADE_TABLE[grade].requiredCoverPercent;
}
