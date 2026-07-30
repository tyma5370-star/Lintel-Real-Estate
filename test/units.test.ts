import { describe, expect, it } from 'vitest';
import {
  fractionToTenthBps,
  MAX_MANAGEMENT_FEE_TENTH_BPS,
  MAX_RATE_TENTH_BPS,
  money,
  moneyCeil,
  percentToTenthBps,
  tenthBpsToFraction,
  tenthBpsToPercent,
} from '../src/units';

/**
 * Rate-unit confusion is the most likely silent bug in this project: a rate that
 * is wrong by 10x does not throw anywhere, it just produces a loan that is wrong.
 * These tests pin the conversion at the exact values the spec documents.
 */

describe('percentToTenthBps', () => {
  it('converts the values documented in the spec', () => {
    expect(percentToTenthBps(0.5)).toBe(500);
    expect(percentToTenthBps(1)).toBe(1_000);
    expect(percentToTenthBps(9.5)).toBe(9_500);
    expect(percentToTenthBps(100)).toBe(100_000);
  });

  it('treats 1/10 basis point as 0.001%', () => {
    expect(percentToTenthBps(0.001)).toBe(1);
  });

  it('does NOT confuse 10% with 100000 — that is 100%', () => {
    // This is the exact 10x error the units module exists to prevent.
    expect(percentToTenthBps(10)).toBe(10_000);
    expect(percentToTenthBps(100)).toBe(100_000);
  });

  it('rejects rates above the protocol ceiling', () => {
    expect(() => percentToTenthBps(101)).toThrow(/protocol maximum/);
  });

  it('enforces the tighter ceiling on management fees', () => {
    expect(percentToTenthBps(10, MAX_MANAGEMENT_FEE_TENTH_BPS)).toBe(10_000);
    expect(() => percentToTenthBps(10.1, MAX_MANAGEMENT_FEE_TENTH_BPS)).toThrow(/protocol maximum/);
  });

  it('rejects negative rates and non-finite input', () => {
    expect(() => percentToTenthBps(-1)).toThrow(/negative/);
    expect(() => percentToTenthBps(Number.NaN)).toThrow(/finite/);
    expect(() => percentToTenthBps(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('round-trips through its inverse', () => {
    for (const percent of [0, 0.5, 1, 7.5, 9.5, 14, 100]) {
      expect(tenthBpsToPercent(percentToTenthBps(percent))).toBeCloseTo(percent, 9);
    }
  });
});

describe('fractionToTenthBps', () => {
  it('takes a decimal fraction rather than a percent', () => {
    expect(fractionToTenthBps(0.095)).toBe(9_500);
    expect(fractionToTenthBps(1)).toBe(MAX_RATE_TENTH_BPS);
  });

  it('round-trips through its inverse', () => {
    expect(tenthBpsToFraction(fractionToTenthBps(0.095))).toBeCloseTo(0.095, 9);
  });
});

describe('money', () => {
  it('formats to two decimal places', () => {
    expect(money(1000.5)).toBe('1000.50');
    expect(money(1000)).toBe('1000.00');
    expect(money(0.005)).toBe('0.01');
  });

  it('rejects non-finite amounts', () => {
    expect(() => money(Number.NaN)).toThrow(/finite/);
  });
});

describe('moneyCeil', () => {
  it('rounds up, so a late payment is never a cent short', () => {
    expect(moneyCeil(1000.001)).toBe('1000.01');
    expect(moneyCeil(1000.011)).toBe('1000.02');
  });

  it('leaves an exact figure alone rather than inflating it', () => {
    expect(moneyCeil(1000.5)).toBe('1000.50');
    expect(moneyCeil(1000)).toBe('1000.00');
  });
});
