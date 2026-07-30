import type { Client } from 'xrpl';
import { rippleTimeToUnixTime } from 'xrpl';
import { DEMO_CURRENCY } from '../config';
import { toNumber } from '../units';

/**
 * Read paths. Everything here hits the network — nothing is served from cache.
 *
 * Every write in this project is followed by a read from here, because the
 * ledger is the only authority on vault and loan state.
 */

export interface VaultView {
  vaultId: string;
  account: string;
  owner: string;
  shareMptId: string;
  scale: number;
  assetsTotal: number;
  assetsAvailable: number;
  lossUnrealized: number;
  assetsMaximum: number;
  withdrawalPolicy: number;
  data?: string;
  /** Total share supply, read off the share MPT issuance. */
  sharesOutstanding: bigint;
}

export interface BrokerView {
  brokerId: string;
  account: string;
  owner: string;
  vaultId: string;
  managementFeeRate: number;
  debtTotal: number;
  debtMaximum: number;
  coverAvailable: number;
  coverRateMinimum: number;
  coverRateLiquidation: number;
  /** Cover required right now, given current DebtTotal. */
  coverRequired: number;
  /** coverAvailable / coverRequired, or Infinity when nothing is drawn. */
  coverRatio: number;
  /** True while the broker may not originate: cover below the required minimum. */
  originationBlocked: boolean;
}

export interface LoanView {
  loanId: string;
  brokerId: string;
  borrower: string;
  flags: number;
  impaired: boolean;
  defaulted: boolean;
  overpaymentAllowed: boolean;
  interestRate: number;
  lateInterestRate: number;
  closeInterestRate: number;
  loanServiceFee: number;
  latePaymentFee: number;
  closePaymentFee: number;
  /** Present when the loan's amounts are scaled integers — see the note in getLoan. */
  loanScale?: number;
  startDate: number;
  paymentInterval: number;
  gracePeriod: number;
  nextPaymentDueDate: number;
  previousPaymentDueDate?: number;
  paymentRemaining: number;
  periodicPayment: number;
  principalOutstanding: number;
  totalValueOutstanding: number;
  managementFeeOutstanding: number;
}

/** The authoritative clock. Never use `Date.now()` for a due-date comparison. */
export async function validatedCloseTime(client: Client): Promise<{ ripple: number; unixMs: number }> {
  const response = await client.request({ command: 'ledger', ledger_index: 'validated' });
  const ripple = (response.result.ledger as { close_time: number }).close_time;
  return { ripple, unixMs: rippleTimeToUnixTime(ripple) };
}

export async function getVault(client: Client, vaultId: string): Promise<VaultView> {
  // `vault_info` is newer than xrpl.js's typed request union, so it goes through
  // untyped and the response is narrowed by hand.
  const response = (await client.request({
    command: 'vault_info',
    vault_id: vaultId,
  } as never)) as unknown as { result: { vault: Record<string, any> } };
  const vault = response.result.vault;

  const scale = toNumber(vault.Scale, 0);
  const shareMptId: string = vault.ShareMPTID ?? vault.shares?.mpt_issuance_id;

  return {
    vaultId,
    account: vault.Account,
    owner: vault.Owner,
    shareMptId,
    scale,
    assetsTotal: toNumber(vault.AssetsTotal),
    assetsAvailable: toNumber(vault.AssetsAvailable),
    lossUnrealized: toNumber(vault.LossUnrealized),
    assetsMaximum: toNumber(vault.AssetsMaximum),
    withdrawalPolicy: toNumber(vault.WithdrawalPolicy),
    data: vault.Data,
    sharesOutstanding: BigInt(vault.shares?.OutstandingAmount ?? vault.OutstandingAmount ?? '0'),
  };
}

export async function getBroker(client: Client, brokerId: string): Promise<BrokerView> {
  const response = await client.request({
    command: 'ledger_entry',
    index: brokerId,
    ledger_index: 'validated',
  });
  const broker = response.result.node as unknown as Record<string, any>;

  const debtTotal = toNumber(broker.DebtTotal);
  const coverAvailable = toNumber(broker.CoverAvailable);
  const coverRateMinimum = toNumber(broker.CoverRateMinimum);
  // CoverRateMinimum is in 1/10 bps: 100000 == 100% of outstanding debt.
  const coverRequired = (debtTotal * coverRateMinimum) / 100_000;

  return {
    brokerId,
    account: broker.Account,
    owner: broker.Owner,
    vaultId: broker.VaultID,
    managementFeeRate: toNumber(broker.ManagementFeeRate),
    debtTotal,
    debtMaximum: toNumber(broker.DebtMaximum),
    coverAvailable,
    coverRateMinimum,
    coverRateLiquidation: toNumber(broker.CoverRateLiquidation),
    coverRequired,
    coverRatio: coverRequired === 0 ? Infinity : coverAvailable / coverRequired,
    originationBlocked: coverAvailable < coverRequired,
  };
}

export async function getLoan(client: Client, loanId: string): Promise<LoanView> {
  const response = await client.request({
    command: 'ledger_entry',
    index: loanId,
    ledger_index: 'validated',
  });
  const loan = response.result.node as unknown as Record<string, any>;
  const flags = toNumber(loan.Flags);

  // `LoanScale` mirrors the vault's Scale. Amount fields on the Loan entry come
  // back as plain decimal strings in the asset's own units, so no rescaling is
  // applied here — it is surfaced only so the lifecycle probe can assert that
  // assumption rather than leave it implicit.
  return {
    loanId,
    loanScale: loan.LoanScale === undefined ? undefined : toNumber(loan.LoanScale),
    brokerId: loan.LoanBrokerID,
    borrower: loan.Borrower,
    flags,
    // LoanFlags, confirmed from xrpl.js v5 models/ledger/Loan.d.ts
    defaulted: (flags & 0x00010000) !== 0, // lsfLoanDefault
    impaired: (flags & 0x00020000) !== 0, // lsfLoanImpaired
    overpaymentAllowed: (flags & 0x00040000) !== 0, // lsfLoanOverpayment
    interestRate: toNumber(loan.InterestRate),
    lateInterestRate: toNumber(loan.LateInterestRate),
    loanServiceFee: toNumber(loan.LoanServiceFee),
    latePaymentFee: toNumber(loan.LatePaymentFee),
    closePaymentFee: toNumber(loan.ClosePaymentFee),
    closeInterestRate: toNumber(loan.CloseInterestRate),
    startDate: toNumber(loan.StartDate),
    paymentInterval: toNumber(loan.PaymentInterval),
    gracePeriod: toNumber(loan.GracePeriod),
    nextPaymentDueDate: toNumber(loan.NextPaymentDueDate),
    previousPaymentDueDate: loan.PreviousPaymentDueDate ? toNumber(loan.PreviousPaymentDueDate) : undefined,
    paymentRemaining: toNumber(loan.PaymentRemaining),
    periodicPayment: toNumber(loan.PeriodicPayment),
    principalOutstanding: toNumber(loan.PrincipalOutstanding),
    totalValueOutstanding: toNumber(loan.TotalValueOutstanding),
    managementFeeOutstanding: toNumber(loan.ManagementFeeOutstanding),
  };
}

/** Does a Loan entry still exist? Used by teardown, which must be idempotent. */
export async function loanExists(client: Client, loanId: string): Promise<boolean> {
  try {
    await getLoan(client, loanId);
    return true;
  } catch (error) {
    if (isEntryNotFound(error)) return false;
    throw error;
  }
}

export async function entryExists(client: Client, id: string): Promise<boolean> {
  try {
    await client.request({ command: 'ledger_entry', index: id, ledger_index: 'validated' });
    return true;
  } catch (error) {
    if (isEntryNotFound(error)) return false;
    throw error;
  }
}

/**
 * Did this request fail because the ledger entry simply is not there?
 *
 * Checked against the structured `data.error` code first, because the human
 * message varies ("Entry not found." from `ledger_entry`, "entryNotFound" from
 * others) and matching on prose alone silently misses cases — which turns an
 * idempotent teardown into one that crashes on its second run.
 */
export function isEntryNotFound(error: unknown): boolean {
  const code = (error as { data?: { error?: string } })?.data?.error;
  if (code && /entryNotFound|objectNotFound|lgrIdxMalformed/i.test(code)) return true;

  const message = error instanceof Error ? error.message : String(error);
  return /entry\s*not\s*found|entryNotFound|objectNotFound/i.test(message);
}

/** IOU balance of `currency` issued by `issuer`, held by `address`. */
export async function iouBalance(
  client: Client,
  address: string,
  issuer: string,
  currency = DEMO_CURRENCY,
): Promise<number> {
  const response = await client.request({
    command: 'account_lines',
    account: address,
    peer: issuer,
    ledger_index: 'validated',
  });
  const line = response.result.lines.find((l) => l.currency === currency);
  return line ? Number(line.balance) : 0;
}

/** MPT balance held by `address` for a given issuance — i.e. a share position. */
export async function mptBalance(client: Client, address: string, mptIssuanceId: string): Promise<bigint> {
  const response = await client.request({
    command: 'account_objects',
    account: address,
    type: 'mptoken',
    ledger_index: 'validated',
  });
  const token = (response.result.account_objects as Array<Record<string, any>>).find(
    (o) => o.MPTokenIssuanceID === mptIssuanceId,
  );
  return BigInt(token?.MPTAmount ?? '0');
}

export async function xrpBalance(client: Client, address: string): Promise<number> {
  const response = await client.request({
    command: 'account_info',
    account: address,
    ledger_index: 'validated',
  });
  return Number(response.result.account_data.Balance) / 1_000_000;
}
