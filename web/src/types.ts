/** Shapes returned by the Bridge API. Mirrors src/server/routes.ts. */

export interface Health {
  network: string;
  connected: boolean;
  validatedCloseTime: { ripple: number; iso: string };
  fundOpen: boolean;
  vaultId: string | null;
  brokerId: string | null;
}

export interface Nav {
  assetsTotal: number;
  assetsAvailable: number;
  lossUnrealized: number;
  netAssets: number;
  sharesOutstanding: number;
  navPerShare: number;
  /** What a share costs on the way in — priced on gross assets. */
  depositRatePerShare: number;
  /** What a share is worth on the way out — net of unrealized loss. */
  redemptionRatePerShare: number;
}

export interface Cover {
  available: number;
  required: number;
  ratio: number | null;
  minimumPercent: number;
  liquidationPercent: number;
  debtOutstanding: number;
  debtMaximum: number;
  originationBlocked: boolean;
}

export interface Position {
  address: string;
  shares: string;
  sharesScaled: number;
  value: number;
  ownership: number;
}

export interface NavPoint {
  at: string;
  navPerShare: number;
  note: string;
}

export interface Fund {
  vault: {
    vaultId: string;
    account: string;
    explorer: string;
    shareMptId: string;
    scale: number;
    data?: string;
  };
  nav: Nav;
  cover: Cover | null;
  positions: Position[];
  navHistory: NavPoint[];
}

export type Grade = 'A' | 'B' | 'C' | 'D';

export interface Metrics {
  totalProjectCost: number;
  effectiveGrossIncome: number;
  operatingExpenses: number;
  netOperatingIncome: number;
  ltc: number;
  ltvAsIs: number;
  arvLtv: number;
  annualDebtService: number;
  dscr: number;
  debtYield: number;
  exitCoverage: number;
  equityRequired: number;
  initialAdvance: number;
  rehabHoldback: number;
  advanceLtvAsIs: number;
}

export interface SizingConstraint {
  name: string;
  maxLoan: number;
  description: string;
}

export interface Underwriting {
  dealId: string;
  address: string;
  metrics: Metrics;
  sizing: { loanAmount: number; bindingConstraint: string; constraints: SizingConstraint[] };
  decision: { approved: boolean; grade: Grade; declineReasons: string[]; bindingConstraint: string };
  terms?: {
    loanAmount: number;
    annualRatePercent: number;
    termMonths: number;
    paymentCount: number;
    monthlyPayment: number;
    balloonAtExit: number;
    originationFee: number;
    servicingFee: number;
    latePaymentFee: number;
    closePaymentFee: number;
    totalInterest: number;
    requiredCoverPercent: number;
  };
}

export interface Disclosure {
  realTermMonths: number;
  realAnnualRatePercent: number;
  onChainPaymentCount: number;
  onChainIntervalSeconds: number;
  termsAreReal: boolean;
  gracePeriodSeconds: number;
  graceShortened: boolean;
  interestRateBasis: string;
  expectedPeriodicPayment: number;
  expectedTotalInterest: number;
  rateClamped: boolean;
  note: string;
}

export interface OnChainTerms {
  principalRequested: string;
  interestRate: number;
  paymentTotal: number;
  paymentInterval: number;
  gracePeriod: number;
  loanOriginationFee: string;
  loanServiceFee: string;
  latePaymentFee: string;
  closePaymentFee: string;
  overpaymentFee: number;
  lateInterestRate: number;
  closeInterestRate: number;
  overpaymentInterestRate: number;
  allowOverpayment: boolean;
  compression: Disclosure;
}

export interface LoanOnLedger {
  loanId: string;
  borrower: string;
  impaired: boolean;
  defaulted: boolean;
  interestRate: number;
  paymentInterval: number;
  gracePeriod: number;
  nextPaymentDueDate: number;
  paymentRemaining: number;
  periodicPayment: number;
  principalOutstanding: number;
  totalValueOutstanding: number;
  loanServiceFee: number;
  daysPastDue: number;
  defaultableAt: number;
  defaultableNow: boolean;
  scheduleLabel: string;
}

export interface Loan {
  loanId: string;
  dealId: string;
  address: string;
  status: 'active' | 'repaid' | 'impaired' | 'defaulted' | 'deleted';
  grade: Grade;
  originationHash: string;
  explorer: string;
  terms?: Underwriting['terms'];
  onChainTerms: OnChainTerms;
  disclosure: Disclosure;
  onLedger: LoanOnLedger | null;
}

export interface DealInput {
  id: string;
  address: string;
  purchasePrice: number;
  rehabBudget: number;
  afterRepairValue: number;
  asIsValue: number;
  monthlyGrossRent: number;
  vacancyRate: number;
  monthlyTaxes: number;
  monthlyInsurance: number;
  monthlyHOA: number;
  maintenanceReserveRate: number;
  managementFeeRate: number;
  termMonths: number;
  exitStrategy: 'refinance' | 'sale';
  sponsorLiquidity: number;
  sponsorPriorDeals: number;
}

export interface DealBundle {
  input: DealInput;
  underwriting: Underwriting;
  onChainTerms: OnChainTerms | null;
}

/** Mirrors POLICY in src/underwriting/policy.ts. Spelled out rather than
 *  `Record<string, number>` so a renamed threshold is a compile error here. */
export interface CreditBox {
  maxArvLtv: number;
  maxLtc: number;
  maxLtvAsIs: number;
  minDscr: number;
  minDebtYield: number;
  sellingCostRate: number;
  minExitCoverage: number;
  minLiquidityMonths: number;
  minViableLtc: number;
  baseRatePercent: number;
  originationFeeRate: number;
  servicingFeeRate: number;
  latePaymentFeeRate: number;
  closeFeeRate: number;
  closeInterestPremiumPercent: number;
  overpaymentFeePercent: number;
  latePenaltyPercent: number;
}

export interface Policy {
  policy: CreditBox;
  grades: Record<Grade, { spreadPercent: number; requiredCoverPercent: number; label: string }>;
}

export interface TxLogEntry {
  label: string;
  type: string;
  hash: string;
  result: string;
  at: string;
  explorer: string;
}
