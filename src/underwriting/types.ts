/**
 * Underwriting domain types.
 *
 * Every field on `DealInput` is required. Nothing is optional and nothing
 * defaults, because an unstated assumption is exactly how bad underwriting
 * happens — a rent roll that quietly assumes zero HOA produces a DSCR that is
 * wrong in the borrower's favour, and no error is ever raised.
 */

export interface DealInput {
  /** Stable identifier for the deal. */
  id: string;
  /** Property address, for narration and the loan's on-ledger Data note. */
  address: string;

  // ── Basis ────────────────────────────────────────────────────────────────
  purchasePrice: number;
  rehabBudget: number;
  /** After-repair value: the appraised value once the scope of work is complete. */
  afterRepairValue: number;
  /** As-is value today, before any work. */
  asIsValue: number;

  // ── Stabilised income ────────────────────────────────────────────────────
  /** Gross monthly rent at stabilisation, not in place today. */
  monthlyGrossRent: number;
  /** Vacancy and credit loss, as a decimal (0.07 = 7%). */
  vacancyRate: number;
  monthlyTaxes: number;
  monthlyInsurance: number;
  /** Do not pass 0 unless the property genuinely has no HOA. */
  monthlyHOA: number;
  /** Maintenance/capex reserve as a decimal share of effective gross income. */
  maintenanceReserveRate: number;
  /** Property management fee as a decimal share of effective gross income. */
  managementFeeRate: number;

  // ── Structure and exit ───────────────────────────────────────────────────
  termMonths: number;
  exitStrategy: 'refinance' | 'sale';

  // ── Sponsor ──────────────────────────────────────────────────────────────
  /** Liquid post-close reserves, in currency units. */
  sponsorLiquidity: number;
  /** Number of comparable projects completed. */
  sponsorPriorDeals: number;
}

export type Grade = 'A' | 'B' | 'C' | 'D';

export type ConstraintName = 'arvLtv' | 'ltc' | 'asIsAdvance' | 'dscr' | 'debtYield' | 'exitCoverage';

export interface SizingConstraint {
  name: ConstraintName;
  /** Maximum loan this constraint permits. */
  maxLoan: number;
  /** Human-readable statement of the limit, for the decline reason and the UI. */
  description: string;
}

export interface Metrics {
  totalProjectCost: number;
  effectiveGrossIncome: number;
  operatingExpenses: number;
  netOperatingIncome: number;
  /** Loan-dependent metrics, evaluated at the sized loan amount. */
  ltc: number;
  ltvAsIs: number;
  arvLtv: number;
  /** Annual debt service, interest-only — bridge loans do not amortise in term. */
  annualDebtService: number;
  dscr: number;
  debtYield: number;
  exitCoverage: number;
  /** Cash the sponsor must bring: total project cost less loan proceeds. */
  equityRequired: number;
  /** Funded at close, against the as-is value. */
  initialAdvance: number;
  /** Held back and released against completed work. */
  rehabHoldback: number;
  /** initialAdvance / asIsValue — the ratio that actually matters at close. */
  advanceLtvAsIs: number;
}

export interface Sizing {
  /** The loan amount, being the minimum across all binding constraints. */
  loanAmount: number;
  /** Which constraint bound. */
  bindingConstraint: ConstraintName;
  constraints: SizingConstraint[];
}

export interface Decision {
  approved: boolean;
  grade: Grade;
  /** Populated when `approved` is false. */
  declineReasons: string[];
  /** The constraint that determined the loan amount, or that caused the decline. */
  bindingConstraint: ConstraintName;
}

export interface RealWorldTerms {
  loanAmount: number;
  /** Annual nominal interest rate, as a percent (9.5 = 9.5%). */
  annualRatePercent: number;
  termMonths: number;
  /** Monthly payments. */
  paymentCount: number;
  /** One month of interest — the loan is interest-only during its term. */
  monthlyPayment: number;
  /** Principal retired at exit (refinance or sale). */
  balloonAtExit: number;
  originationFee: number;
  /** Charged per payment. */
  servicingFee: number;
  latePaymentFee: number;
  closePaymentFee: number;
  totalInterest: number;
  requiredCoverPercent: number;
}

export interface Underwriting {
  dealId: string;
  address: string;
  metrics: Metrics;
  sizing: Sizing;
  decision: Decision;
  /** Only present when approved. */
  terms?: RealWorldTerms;
}
