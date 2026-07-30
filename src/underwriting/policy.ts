import type { Grade } from './types';

/**
 * The credit box.
 *
 * This is the fund's policy, stated once, as data. Every number the engine
 * produces traces back to a line in this file, which is what makes the output
 * auditable rather than merely plausible. The README reproduces this table; a
 * reader should be able to see the policy, not just its consequences.
 *
 * A hash of this file is committed into the vault's on-ledger `Data` field, so
 * the policy the fund claims to run is verifiable against the policy it ran.
 */

export const POLICY = {
  /** Maximum loan as a share of after-repair value. The primary bridge constraint. */
  maxArvLtv: 0.7,

  /** Maximum loan as a share of total project cost (purchase + rehab). */
  maxLtc: 0.85,

  /** Maximum loan as a share of as-is value at close. */
  maxLtvAsIs: 0.8,

  /** Minimum stabilised debt-service coverage. Below this, we do not lend. */
  minDscr: 1.2,

  /** Minimum debt yield — NOI / loan. Protects against cap-rate compression in the exit. */
  minDebtYield: 0.09,

  /** Transaction costs assumed on a sale exit, as a share of ARV. */
  sellingCostRate: 0.07,

  /** Minimum exit coverage: net sale proceeds over loan payoff. */
  minExitCoverage: 1.15,

  /** Sponsor must hold this many months of debt service in post-close liquidity. */
  minLiquidityMonths: 6,

  /**
   * Minimum viable LTC.
   *
   * If the tightest constraint holds the loan below this share of total project
   * cost, we decline rather than issue a term sheet nobody can close on. A bridge
   * loan at 40% LTC leaves the sponsor funding most of the project themselves, at
   * which point our origination and servicing economics do not justify the credit
   * work — and in practice the deal falls through anyway.
   *
   * This is what makes a decline possible at all. Every ratio floor above is
   * enforced by *sizing*, so a sized loan satisfies them by construction; testing
   * them again after sizing can never fail. Proceeds adequacy is the constraint
   * that sizing cannot satisfy by shrinking the loan, because shrinking the loan
   * is what violates it.
   */
  minViableLtc: 0.55,

  /** Base annual rate before the grade spread, as a percent. */
  baseRatePercent: 7.5,

  /** Origination fee as a share of the loan. */
  originationFeeRate: 0.02,

  /** Servicing fee charged per payment, as a share of the loan. */
  servicingFeeRate: 0.001,

  /** Late payment fee as a share of the periodic payment. */
  latePaymentFeeRate: 0.05,

  /** Fee for closing the loan out early, as a share of the loan. */
  closeFeeRate: 0.005,

  /** Premium charged on early full repayment, as an annual percent. */
  closeInterestPremiumPercent: 1.0,

  /** Fee on principal-reducing overpayments, as a percent of the overpayment. */
  overpaymentFeePercent: 1.0,

  /** Penalty rate added to the note rate when a payment is late, as a percent. */
  latePenaltyPercent: 4.0,
} as const;

/**
 * Grade → pricing and required first-loss cover.
 *
 * `spreadPercent` is added to `POLICY.baseRatePercent`. `requiredCoverPercent` is
 * the first-loss subordination this grade demands; it feeds the broker's cover
 * policy and is the mechanism by which weaker credit costs the manager more
 * capital rather than merely more basis points.
 */
export const GRADE_TABLE: Record<Grade, { spreadPercent: number; requiredCoverPercent: number; label: string }> = {
  A: { spreadPercent: 1.0, requiredCoverPercent: 5, label: 'Institutional — low leverage, strong coverage, repeat sponsor' },
  B: { spreadPercent: 2.0, requiredCoverPercent: 10, label: 'Core bridge — within policy on every constraint' },
  C: { spreadPercent: 4.0, requiredCoverPercent: 15, label: 'Story credit — one constraint near its limit' },
  D: { spreadPercent: 6.5, requiredCoverPercent: 25, label: 'Outside the credit box — decline' },
};

/**
 * Grade thresholds, evaluated in order. The first row every condition of which
 * is satisfied wins. `D` is the fallthrough and is always a decline.
 */
export const GRADE_THRESHOLDS: Array<{
  grade: Exclude<Grade, 'D'>;
  minDscr: number;
  maxArvLtv: number;
  minPriorDeals: number;
  minLiquidityMonths: number;
}> = [
  { grade: 'A', minDscr: 1.5, maxArvLtv: 0.6, minPriorDeals: 5, minLiquidityMonths: 12 },
  { grade: 'B', minDscr: 1.3, maxArvLtv: 0.68, minPriorDeals: 2, minLiquidityMonths: 6 },
  { grade: 'C', minDscr: 1.2, maxArvLtv: 0.7, minPriorDeals: 1, minLiquidityMonths: 3 },
];

/** Grades we will actually lend to. */
export const APPROVABLE_GRADES: Grade[] = ['A', 'B', 'C'];

export type Policy = typeof POLICY;
