import { INTEREST_RATE_BASIS, SECONDS_PER_YEAR, type InterestRateBasis } from '../config';
import { money, percentToTenthBps, MAX_RATE_TENTH_BPS } from '../units';
import { periodicPayment } from './amortisation';
import { POLICY } from './policy';
import type { RealWorldTerms } from './types';

/**
 * Real-world terms → XLS-66 `LoanSet` fields.
 *
 * The only conversion boundary between the underwriting engine and the protocol.
 *
 * ─── How the demo is compressed, and why it is done this way ─────────────────
 *
 * The obvious approach is to shrink `PaymentInterval` — represent a month as 120
 * seconds and run the whole loan in minutes. That approach is wrong here, and the
 * reason is worth stating because it is the single most important thing this file
 * encodes.
 *
 * The ledger reads `InterestRate` as an **annualised** rate and charges each
 * period `rate × PaymentInterval / year` (both facts verified empirically — see
 * docs/verified.md). Interest is therefore a function of the interval in
 * *seconds*, so shrinking the interval shrinks the interest by the same factor. A
 * 240-second "two month" period charges 240/31,557,600 of a year: on a $127,500
 * loan at 9.5%, that is **five cents** of total interest instead of $6,600. And it
 * cannot be corrected by raising the rate, because `InterestRate` is capped at
 * 100% (100000 tenth-bps) — the most interest expressible in a 60-second period is
 * 0.00019% of principal.
 *
 * A vault whose NAV moves by five cents demonstrates nothing.
 *
 * So the terms are **not** compressed. `PaymentInterval` is a real month,
 * `PaymentTotal` is the real payment count, and `InterestRate` is the real annual
 * rate. The loan on the ledger is economically the loan the engine underwrote.
 *
 * What is compressed is the *pacing*: installments are paid ahead of their due
 * dates rather than waiting out real months. Prepayment is permitted, an early
 * payment is an on-time payment, and — critically — `PeriodicPayment` is fixed at
 * origination from the interval and the rate, so paying early does not reduce the
 * interest charged. The economics survive; only the waiting is skipped.
 *
 * `GracePeriod` is the one field held at its 60-second floor rather than a real
 * value, so that an impaired loan becomes defaultable inside the demo. That is a
 * genuine deviation and it is disclosed in the block returned below.
 */

/** Seconds in a month, on the ledger's own 365.25-day year. */
export const SECONDS_PER_MONTH = Math.round(SECONDS_PER_YEAR / 12); // 2,629,800

/**
 * `PaymentInterval` has a hard floor of 60 seconds and `GracePeriod` must not
 * exceed it. 60 is therefore the smallest legal grace period.
 */
export const MIN_PAYMENT_INTERVAL = 60;

export interface CompressionSettings {
  /** Seconds used to represent one month on-chain. Real by default — see above. */
  secondsPerMonth: number;
  /**
   * Grace period in seconds. Held at the 60-second floor so an impaired loan can
   * be defaulted within the demo rather than a real month later.
   */
  gracePeriodSeconds: number;
  interestRateBasis: InterestRateBasis;
}

export const DEMO_COMPRESSION: CompressionSettings = {
  secondsPerMonth: SECONDS_PER_MONTH,
  gracePeriodSeconds: MIN_PAYMENT_INTERVAL,
  interestRateBasis: INTEREST_RATE_BASIS,
};

/** The `LoanSet` payload, in protocol units. Mirrors LoanSetTerms in ../ledger/loan.ts. */
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
  note?: string;

  /** Disclosure block — carried alongside so the UI and README cannot drift from it. */
  compression: {
    realTermMonths: number;
    realAnnualRatePercent: number;
    onChainPaymentCount: number;
    onChainIntervalSeconds: number;
    /** True when the on-chain interval is a real month. */
    termsAreReal: boolean;
    /** Grace period, and whether it was shortened for the demo. */
    gracePeriodSeconds: number;
    graceShortened: boolean;
    interestRateBasis: InterestRateBasis;
    /** What the ledger should compute for PeriodicPayment, given its conventions. */
    expectedPeriodicPayment: number;
    /** Total interest the on-chain loan will charge over its life. */
    expectedTotalInterest: number;
    /** True if the rate had to be clamped to the protocol's 100% ceiling. */
    rateClamped: boolean;
    note: string;
  };
}

/**
 * Build the on-chain representation of an approved loan.
 *
 * Every rate here is the real rate. The only translation is units — percent to
 * 1/10 basis points, via ../units, never inline.
 */
export function toOnChainTerms(
  terms: RealWorldTerms,
  address: string,
  settings: CompressionSettings = DEMO_COMPRESSION,
): OnChainTerms {
  const paymentTotal = terms.paymentCount;
  const paymentInterval = Math.max(MIN_PAYMENT_INTERVAL, Math.round(settings.secondsPerMonth));
  const gracePeriod = Math.min(Math.max(MIN_PAYMENT_INTERVAL, settings.gracePeriodSeconds), paymentInterval);

  // The ledger prorates an annualised rate by interval/year. When the interval is
  // a real month that proration is exactly what we want, so the rate submitted is
  // simply the real annual rate.
  const submittedRatePercent =
    settings.interestRateBasis === 'annual'
      ? terms.annualRatePercent
      : terms.annualRatePercent * (paymentInterval / SECONDS_PER_YEAR);

  const rateClamped = submittedRatePercent > MAX_RATE_TENTH_BPS / 1000;
  const interestRate = percentToTenthBps(clampRate(submittedRatePercent));

  // Reproduce the ledger's own arithmetic so we can assert against it after
  // origination rather than trusting that we agree.
  const ledgerPeriodRate =
    settings.interestRateBasis === 'annual'
      ? (interestRate / 100_000) * (paymentInterval / SECONDS_PER_YEAR)
      : interestRate / 100_000;
  const expectedPeriodicPayment = periodicPayment(terms.loanAmount, ledgerPeriodRate, paymentTotal);
  const expectedTotalInterest = expectedPeriodicPayment * paymentTotal - terms.loanAmount;

  const termsAreReal = Math.abs(paymentInterval - SECONDS_PER_MONTH) < 1;

  return {
    principalRequested: money(terms.loanAmount),
    interestRate,
    paymentTotal,
    paymentInterval,
    gracePeriod,
    loanOriginationFee: money(terms.originationFee),
    loanServiceFee: money(terms.servicingFee),
    latePaymentFee: money(terms.latePaymentFee),
    closePaymentFee: money(terms.closePaymentFee),
    overpaymentFee: percentToTenthBps(POLICY.overpaymentFeePercent),
    lateInterestRate: percentToTenthBps(clampRate(submittedRatePercent + POLICY.latePenaltyPercent)),
    closeInterestRate: percentToTenthBps(clampRate(POLICY.closeInterestPremiumPercent)),
    overpaymentInterestRate: percentToTenthBps(clampRate(submittedRatePercent)),
    // Overpayment must be enabled on the Loan entry AND flagged on each LoanPay.
    // Enabling it here is only half of it; omitting either half means the excess
    // is silently ignored and the transaction still returns tesSUCCESS.
    allowOverpayment: true,
    note: `LINTEL|${address}`.slice(0, 200),

    compression: {
      realTermMonths: terms.termMonths,
      realAnnualRatePercent: terms.annualRatePercent,
      onChainPaymentCount: paymentTotal,
      onChainIntervalSeconds: paymentInterval,
      termsAreReal,
      gracePeriodSeconds: gracePeriod,
      graceShortened: gracePeriod < paymentInterval,
      interestRateBasis: settings.interestRateBasis,
      expectedPeriodicPayment,
      expectedTotalInterest,
      rateClamped,
      note:
        `On-chain terms are the real terms: ${paymentTotal} payments of ${paymentInterval}s ` +
        `(one real month) at ${terms.annualRatePercent.toFixed(2)}% annual, charging ` +
        `${money(expectedTotalInterest)} of interest. The demo compresses only the *pacing* — ` +
        `installments are prepaid rather than waited out, which does not change the interest ` +
        `because PeriodicPayment is fixed at origination. GracePeriod is held at ${gracePeriod}s ` +
        `(vs a real month) so an impaired loan can be defaulted inside the demo.`,
    },
  };
}

/** Keep a rate inside the protocol's 0–100% band. */
function clampRate(percent: number): number {
  return Math.min(Math.max(percent, 0), MAX_RATE_TENTH_BPS / 1000);
}

/** Human-readable schedule position, for the UI. Discloses the compression by design. */
export function scheduleLabel(paymentsMade: number, onChain: OnChainTerms): string {
  const total = onChain.compression.onChainPaymentCount;
  return (
    `Payment ${Math.min(paymentsMade + 1, total)} of ${total} · ` +
    `${onChain.compression.realTermMonths}-month loan at ` +
    `${onChain.compression.realAnnualRatePercent.toFixed(2)}% · ` +
    'installments prepaid for the demo'
  );
}
