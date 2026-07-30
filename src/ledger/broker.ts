import type { Client, Wallet } from 'xrpl';
import { convertStringToHex } from 'xrpl';
import { DEMO_CURRENCY } from '../config';
import { MAX_MANAGEMENT_FEE_TENTH_BPS, MAX_RATE_TENTH_BPS, moneyFloor, percentToTenthBps } from '../units';
import { iou } from './amounts';
import { createdEntry, createdEntryId, submit, type SubmitResult } from './submit';

/** XLS-66 — LoanBrokerSet and the first-loss cover pool. */

export interface BrokerPolicy {
  /**
   * Fee the broker takes on loan payments, in percent.
   * Protocol maximum is 10% (10000 tenth-bps).
   */
  managementFeePercent: number;
  /** Hard cap on outstanding debt, as an asset amount. "0" would mean unlimited. */
  debtMaximum: number;
  /**
   * First-loss capital the broker must hold, as a percent of outstanding debt.
   * This is the fund's stated subordination level.
   */
  coverMinimumPercent: number;
  /**
   * Ceiling on how much of the required cover a single default may consume,
   * as a percent. 100 means one default can draw the whole cover pool.
   */
  coverLiquidationPercent: number;
  /** Free-text policy note written into the broker's Data field. */
  note?: string;
}

/**
 * Broker policy for the demo fund.
 *
 * These three rates are **immutable after creation** — LoanBrokerSet cannot
 * change ManagementFeeRate, CoverRateMinimum, or CoverRateLiquidation later.
 * They are a policy decision made once, so they are written down here with
 * reasons rather than being inlined at the call site.
 *
 *   10% cover minimum      — a 10% first-loss tranche is the conventional
 *                            subordination level for a bridge fund of this shape.
 *   100% cover liquidation — one default may draw the entire required cover.
 *                            Setting this lower would cap the protection per
 *                            event and push more loss straight to LP NAV, which
 *                            makes the first-loss tranche largely decorative.
 *    1% management fee      — modest, and well under the 10% protocol ceiling.
 */
export const DEMO_BROKER_POLICY: BrokerPolicy = {
  managementFeePercent: 1,
  debtMaximum: 5_000_000,
  coverMinimumPercent: 10,
  coverLiquidationPercent: 100,
  note: 'Bridge RE first-loss 10pct',
};

export interface CreatedBroker {
  brokerId: string;
  account: string;
  submit: SubmitResult;
}

export async function createBroker(
  client: Client,
  owner: Wallet,
  vaultId: string,
  policy: BrokerPolicy = DEMO_BROKER_POLICY,
): Promise<CreatedBroker> {
  const coverRateMinimum = percentToTenthBps(policy.coverMinimumPercent, MAX_RATE_TENTH_BPS);
  const coverRateLiquidation = percentToTenthBps(policy.coverLiquidationPercent, MAX_RATE_TENTH_BPS);

  // xrpl.js v5 enforces that these are both zero or both non-zero, but it does
  // NOT enforce any relationship between their magnitudes. A liquidation rate
  // above the minimum would let one default draw more than the fund claims to
  // hold in reserve, so we check it ourselves.
  if (coverRateMinimum === 0 && coverRateLiquidation !== 0) {
    throw new RangeError('CoverRateMinimum and CoverRateLiquidation must both be zero or both non-zero.');
  }

  const result = await submit(
    client,
    owner,
    {
      TransactionType: 'LoanBrokerSet',
      Account: owner.classicAddress,
      VaultID: vaultId,
      ManagementFeeRate: percentToTenthBps(policy.managementFeePercent, MAX_MANAGEMENT_FEE_TENTH_BPS),
      DebtMaximum: String(policy.debtMaximum),
      CoverRateMinimum: coverRateMinimum,
      CoverRateLiquidation: coverRateLiquidation,
      ...(policy.note ? { Data: convertStringToHex(policy.note) } : {}),
    } as never,
    'LoanBrokerSet',
  );

  const entry = createdEntry(result.meta, 'LoanBroker');
  return {
    brokerId: createdEntryId(result.meta, 'LoanBroker'),
    account: entry.Account as string,
    submit: result,
  };
}

/**
 * Deposit first-loss capital.
 *
 * While `CoverAvailable` is below the required minimum the broker cannot
 * originate at all, and every fee it earns is diverted into the cover pool
 * instead of being paid out. Deposit meaningfully above the minimum so a default
 * mid-demo does not freeze origination.
 */
export async function depositCover(
  client: Client,
  owner: Wallet,
  brokerId: string,
  amount: number,
  issuer: string,
  currency = DEMO_CURRENCY,
): Promise<SubmitResult> {
  return submit(
    client,
    owner,
    {
      TransactionType: 'LoanBrokerCoverDeposit',
      Account: owner.classicAddress,
      LoanBrokerID: brokerId,
      Amount: iou(amount, issuer, currency),
    },
    `LoanBrokerCoverDeposit ${amount} ${currency}`,
  );
}

/**
 * Withdraw first-loss capital.
 *
 * The amount is floored to the cent. `CoverAvailable` is reported with more
 * precision than an IOU amount can carry, so rounding to nearest asks for more
 * than exists and is rejected with `tecINSUFFICIENT_FUNDS`.
 */
export async function withdrawCover(
  client: Client,
  owner: Wallet,
  brokerId: string,
  amount: number,
  issuer: string,
  currency = DEMO_CURRENCY,
): Promise<SubmitResult> {
  const exact = moneyFloor(amount);
  return submit(
    client,
    owner,
    {
      TransactionType: 'LoanBrokerCoverWithdraw',
      Account: owner.classicAddress,
      LoanBrokerID: brokerId,
      Amount: iou(exact, issuer, currency),
    },
    `LoanBrokerCoverWithdraw ${exact} ${currency}`,
  );
}

export async function deleteBroker(client: Client, owner: Wallet, brokerId: string): Promise<SubmitResult> {
  return submit(
    client,
    owner,
    { TransactionType: 'LoanBrokerDelete', Account: owner.classicAddress, LoanBrokerID: brokerId },
    'LoanBrokerDelete',
  );
}
