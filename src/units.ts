/**
 * Unit conversion. This is the ONLY place a rate becomes a protocol integer.
 *
 * XLS-66 expresses every rate field in **1/10 of a basis point**:
 *
 *     1 basis point   = 0.01%
 *     1/10 basis point = 0.001%
 *
 * so `value = percent * 1000`, and the protocol maximum of 100000 is 100%.
 *
 * A rate that is wrong by 10x does not throw anywhere in the stack — it produces
 * a loan that is simply wrong. Every conversion goes through here, and every
 * conversion is range-checked.
 */

/** Protocol ceiling for InterestRate, LateInterestRate, CloseInterestRate,
 *  OverpaymentInterestRate, OverpaymentFee, CoverRateMinimum, CoverRateLiquidation.
 *  Confirmed against xrpl.js v5 validators (models/transactions/loanSet.js,
 *  loanBrokerSet.js). 100000 tenth-bps = 100%. */
export const MAX_RATE_TENTH_BPS = 100_000;

/** Protocol ceiling for ManagementFeeRate specifically — 10000 = 10%. */
export const MAX_MANAGEMENT_FEE_TENTH_BPS = 10_000;

export type TenthBps = number & { readonly __brand: 'TenthBps' };

/**
 * Convert a percentage to 1/10 basis points.
 *
 *   percentToTenthBps(1)    -> 1000
 *   percentToTenthBps(8.5)  -> 8500
 *   percentToTenthBps(100)  -> 100000
 */
export function percentToTenthBps(percent: number, max = MAX_RATE_TENTH_BPS): TenthBps {
  if (!Number.isFinite(percent)) {
    throw new RangeError(`percentToTenthBps: not a finite number: ${percent}`);
  }
  if (percent < 0) {
    throw new RangeError(`percentToTenthBps: rates may not be negative (got ${percent}%)`);
  }
  const value = Math.round(percent * 1000);
  if (value > max) {
    throw new RangeError(
      `percentToTenthBps: ${percent}% = ${value} tenth-bps, above the protocol maximum of ${max} (${max / 1000}%)`,
    );
  }
  return value as TenthBps;
}

/** Inverse of {@link percentToTenthBps}, for display and for reading ledger entries back. */
export function tenthBpsToPercent(tenthBps: number): number {
  return tenthBps / 1000;
}

/** Convert a decimal fraction (0.095) rather than a percent (9.5). */
export function fractionToTenthBps(fraction: number, max = MAX_RATE_TENTH_BPS): TenthBps {
  return percentToTenthBps(fraction * 100, max);
}

export function tenthBpsToFraction(tenthBps: number): number {
  return tenthBps / 100_000;
}

/**
 * Format a money amount as an IOU value string.
 *
 * IOU amounts are decimal strings with at most 16 significant figures. We round
 * to `dp` decimal places (2 by default — this is a USD-denominated fund) so that
 * client-side arithmetic and the ledger agree on the last digit.
 */
export function money(amount: number, dp = 2): string {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`money: not a finite number: ${amount}`);
  }
  const rounded = Math.round(amount * 10 ** dp) / 10 ** dp;
  return rounded.toFixed(dp);
}

/**
 * Round *up* to `dp` places. Used when PAYING: the ledger requires at least the
 * exact figure, and `PeriodicPayment` carries far more precision than cents, so
 * rounding to nearest is short about half the time (`tecINSUFFICIENT_PAYMENT`).
 */
export function moneyCeil(amount: number, dp = 2): string {
  const factor = 10 ** dp;
  return (Math.ceil(amount * factor - 1e-9) / factor).toFixed(dp);
}

/**
 * Round *down* to `dp` places. The mirror of {@link moneyCeil}, used when
 * WITHDRAWING a full balance: `CoverAvailable` comes back as 69182.7760210308,
 * and asking for 69182.78 is asking for more than exists
 * (`tecINSUFFICIENT_FUNDS`).
 */
export function moneyFloor(amount: number, dp = 2): string {
  const factor = 10 ** dp;
  return (Math.floor(amount * factor + 1e-9) / factor).toFixed(dp);
}

export const toNumber = (value: string | number | undefined, fallback = 0): number =>
  value === undefined ? fallback : typeof value === 'number' ? value : Number(value);
