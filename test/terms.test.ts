import { describe, expect, it } from 'vitest';
import { SECONDS_PER_YEAR } from '../src/config';
import { CLEVELAND } from '../src/demo/deals';
import { periodicPayment } from '../src/underwriting/amortisation';
import { underwrite } from '../src/underwriting/engine';
import { MIN_PAYMENT_INTERVAL, SECONDS_PER_MONTH, toOnChainTerms } from '../src/underwriting/terms';
import { MAX_RATE_TENTH_BPS } from '../src/units';

/**
 * These tests encode what was learned from the ledger itself (docs/verified.md):
 * `InterestRate` is annualised and prorated by PaymentInterval over a 365.25-day
 * year. Getting this wrong is silent, so it is pinned here.
 */

const { terms } = underwrite(CLEVELAND);
const onChain = toOnChainTerms(terms!, CLEVELAND.address);

describe('ledger conventions', () => {
  it('uses a 365.25-day Julian year, as verified against the ledger', () => {
    expect(SECONDS_PER_YEAR).toBe(31_557_600);
  });

  it('represents a month as a real month, not a compressed one', () => {
    expect(SECONDS_PER_MONTH).toBe(2_629_800);
    expect(onChain.paymentInterval).toBe(SECONDS_PER_MONTH);
    expect(onChain.compression.termsAreReal).toBe(true);
  });
});

describe('toOnChainTerms', () => {
  it('submits the real annual rate, undistorted', () => {
    expect(onChain.interestRate).toBe(9_500);
    expect(onChain.compression.realAnnualRatePercent).toBeCloseTo(9.5, 6);
  });

  it('keeps every rate inside the protocol ceiling', () => {
    for (const rate of [
      onChain.interestRate,
      onChain.lateInterestRate,
      onChain.closeInterestRate,
      onChain.overpaymentInterestRate,
      onChain.overpaymentFee,
    ]) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(MAX_RATE_TENTH_BPS);
    }
  });

  it('satisfies both PaymentInterval and GracePeriod constraints', () => {
    expect(onChain.paymentInterval).toBeGreaterThanOrEqual(MIN_PAYMENT_INTERVAL);
    expect(onChain.gracePeriod).toBeGreaterThanOrEqual(MIN_PAYMENT_INTERVAL);
    expect(onChain.gracePeriod).toBeLessThanOrEqual(onChain.paymentInterval);
  });

  it('predicts the PeriodicPayment the ledger will compute', () => {
    // Reproduce the ledger's arithmetic independently of the implementation.
    const periodRate = (onChain.interestRate / 100_000) * (onChain.paymentInterval / SECONDS_PER_YEAR);
    const expected = periodicPayment(terms!.loanAmount, periodRate, onChain.paymentTotal);
    expect(onChain.compression.expectedPeriodicPayment).toBeCloseTo(expected, 6);
  });

  it('charges economically meaningful interest — the whole point of real intervals', () => {
    // A compressed 240-second "month" would charge about five cents here.
    expect(onChain.compression.expectedTotalInterest).toBeGreaterThan(5_000);
  });

  it('discloses that the grace period was shortened for the demo', () => {
    expect(onChain.gracePeriod).toBe(MIN_PAYMENT_INTERVAL);
    expect(onChain.compression.graceShortened).toBe(true);
    expect(onChain.compression.note).toMatch(/GracePeriod/);
  });

  it('does not need to clamp the rate at realistic intervals', () => {
    expect(onChain.compression.rateClamped).toBe(false);
  });

  it('emits amounts as decimal strings and rates as integers', () => {
    expect(onChain.principalRequested).toBe('127500.00');
    expect(Number.isInteger(onChain.interestRate)).toBe(true);
    expect(Number.isInteger(onChain.paymentInterval)).toBe(true);
  });

  it('enables overpayment on the Loan entry — half of what overpayment needs', () => {
    // The other half is the flag on each LoanPay; missing either is silent.
    expect(onChain.allowOverpayment).toBe(true);
  });

  it('clamps and flags a rate that a compressed interval would push over 100%', () => {
    const compressed = toOnChainTerms(terms!, CLEVELAND.address, {
      secondsPerMonth: 120,
      gracePeriodSeconds: 60,
      interestRateBasis: 'per-period',
    });
    // At a 120s "month" the per-period basis needs a rate far above the ceiling.
    expect(compressed.paymentInterval).toBe(120);
    expect(compressed.compression.rateClamped).toBe(false);
    // And the interest it can charge collapses to nothing — the reason we do not
    // compress the terms.
    expect(compressed.compression.expectedTotalInterest).toBeLessThan(1);
  });
});
