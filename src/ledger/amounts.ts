import type { Currency, IssuedCurrencyAmount } from 'xrpl';
import { DEMO_CURRENCY } from '../config';
import { money } from '../units';

/**
 * Amount construction — one place only.
 *
 * Three amount shapes exist on XRPL and this project touches all three:
 *   XRP  — a bare drops string
 *   IOU  — { currency, issuer, value } with a decimal string value
 *   MPT  — { mpt_issuance_id, value } with an INTEGER string value scaled by AssetScale
 *
 * The vault's asset is an IOU (decision D4). The vault's *shares* are an MPT
 * minted by the vault itself, so share amounts take the MPT shape. Mixing these
 * up is the single easiest way to produce a transaction that is rejected for
 * reasons that read as unrelated to the actual mistake.
 */

export interface MPTAmount {
  mpt_issuance_id: string;
  value: string;
}

/** The ISSUE object identifying the vault's asset (used by `VaultCreate.Asset`). */
export function assetCurrency(issuer: string, currency = DEMO_CURRENCY): Currency {
  return { currency, issuer } as Currency;
}

/** An IOU payment/deposit amount of the demo stablecoin. */
export function iou(value: number | string, issuer: string, currency = DEMO_CURRENCY): IssuedCurrencyAmount {
  return {
    currency,
    issuer,
    value: typeof value === 'number' ? money(value) : value,
  };
}

/** A share amount, denominated in the vault's share MPT. Value must be an integer string. */
export function shares(mptIssuanceId: string, value: number | string | bigint): MPTAmount {
  const asString =
    typeof value === 'bigint' ? value.toString() : typeof value === 'number' ? Math.trunc(value).toString() : value;
  if (!/^\d+$/.test(asString)) {
    throw new RangeError(`shares: MPT amounts must be non-negative integer strings, got "${asString}"`);
  }
  return { mpt_issuance_id: mptIssuanceId, value: asString };
}

/** XRP, in drops. */
export const xrp = (drops: number | string): string => String(drops);

/**
 * Vault share <-> asset scaling.
 *
 * On an empty vault the first depositor receives `assets * 10^Scale` shares.
 * After that the exchange rate floats, so these helpers are only correct for
 * interpreting the *initial* mint and for formatting share balances for display.
 */
export const sharesFromAssets = (assets: number, scale: number): bigint =>
  BigInt(Math.round(assets * 10 ** scale));

export const assetsFromShares = (shareCount: bigint | string, scale: number): number =>
  Number(BigInt(shareCount)) / 10 ** scale;
