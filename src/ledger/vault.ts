import type { Client, Wallet } from 'xrpl';
import { convertStringToHex, VaultWithdrawalPolicy } from 'xrpl';
import { DEMO_CURRENCY, VAULT_SCALE } from '../config';
import { assetCurrency, iou, shares, type MPTAmount } from './amounts';
import { createdEntry, createdEntryId, submit, type SubmitResult } from './submit';

/** XLS-65 Single Asset Vault — VaultCreate / Deposit / Withdraw / Delete. */

/** VaultCreate.Data is capped at 256 bytes (VAULT_DATA_MAX_BYTE_LENGTH in xrpl.js v5). */
export const VAULT_DATA_MAX_BYTES = 256;

export interface FundIdentity {
  /** Fund name. */
  name: string;
  /** Strategy shorthand, e.g. "RE-BRIDGE". */
  strategy: string;
  /** Target ARV-LTV band as percentages, e.g. [60, 75]. */
  targetLtvBand: [number, number];
  /** Short hash of the underwriting policy document, so the policy is committed on-ledger. */
  policyHash: string;
}

/**
 * Encode the fund identity into the vault's `Data` field.
 *
 * Most vaults will leave `Data` empty. Populating it makes the fund
 * self-describing on-ledger: a third party can read the vault entry and learn
 * the strategy and the exact underwriting policy it is bound to, without
 * trusting our API. 256 bytes is tight, so the encoding is a compact
 * pipe-delimited record rather than JSON.
 */
export function encodeFundIdentity(identity: FundIdentity): string {
  const record = [
    'BRIDGE1',
    identity.name,
    identity.strategy,
    `LTV${identity.targetLtvBand[0]}-${identity.targetLtvBand[1]}`,
    `POL:${identity.policyHash}`,
  ].join('|');

  const hex = convertStringToHex(record);
  if (hex.length / 2 > VAULT_DATA_MAX_BYTES) {
    throw new RangeError(
      `Fund identity is ${hex.length / 2} bytes, over the ${VAULT_DATA_MAX_BYTES}-byte VaultCreate.Data limit: "${record}"`,
    );
  }
  return hex;
}

export interface CreateVaultParams {
  issuer: string;
  currency?: string;
  identity: FundIdentity;
  /** "0" means no cap. Sent as a string — this is a NUMBER field, not an integer. */
  assetsMaximum?: string;
  scale?: number;
}

export interface CreatedVault {
  vaultId: string;
  account: string;
  shareMptId: string;
  scale: number;
  submit: SubmitResult;
}

export async function createVault(
  client: Client,
  owner: Wallet,
  params: CreateVaultParams,
): Promise<CreatedVault> {
  const result = await submit(
    client,
    owner,
    {
      TransactionType: 'VaultCreate',
      Account: owner.classicAddress,
      Asset: assetCurrency(params.issuer, params.currency ?? DEMO_CURRENCY),
      // Flags 0 — a public vault. We deliberately set neither tfVaultPrivate
      // (which would pull in Credentials and Permissioned Domains) nor
      // tfVaultShareNonTransferable.
      Flags: 0,
      AssetsMaximum: params.assetsMaximum ?? '0',
      WithdrawalPolicy: VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
      Scale: params.scale ?? VAULT_SCALE,
      Data: encodeFundIdentity(params.identity),
    },
    'VaultCreate',
  );

  const entry = createdEntry(result.meta, 'Vault');
  return {
    vaultId: createdEntryId(result.meta, 'Vault'),
    account: entry.Account as string,
    shareMptId: entry.ShareMPTID as string,
    scale: Number(entry.Scale ?? params.scale ?? VAULT_SCALE),
    submit: result,
  };
}

/** Deposit assets and receive share MPTs. Priced on the *deposit* exchange rate. */
export async function depositToVault(
  client: Client,
  depositor: Wallet,
  vaultId: string,
  amount: number,
  issuer: string,
  currency = DEMO_CURRENCY,
): Promise<SubmitResult> {
  return submit(
    client,
    depositor,
    {
      TransactionType: 'VaultDeposit',
      Account: depositor.classicAddress,
      VaultID: vaultId,
      Amount: iou(amount, issuer, currency),
    },
    `VaultDeposit ${amount} ${currency}`,
  );
}

/**
 * Redeem shares for assets. Priced on the *redemption* exchange rate, which
 * differs from the deposit rate — redemption reflects current value including
 * unrealized loss, deposit is priced to protect incoming depositors from losses
 * they were not present for.
 *
 * Pass a share MPT amount to redeem a share quantity, or an IOU amount to
 * withdraw a target asset amount.
 */
export async function withdrawFromVault(
  client: Client,
  holder: Wallet,
  vaultId: string,
  amount: MPTAmount | { currency: string; issuer: string; value: string },
  destination?: string,
): Promise<SubmitResult> {
  return submit(
    client,
    holder,
    {
      TransactionType: 'VaultWithdraw',
      Account: holder.classicAddress,
      VaultID: vaultId,
      Amount: amount as never,
      ...(destination ? { Destination: destination } : {}),
    },
    'VaultWithdraw',
  );
}

export const shareAmount = shares;

export async function deleteVault(client: Client, owner: Wallet, vaultId: string): Promise<SubmitResult> {
  return submit(
    client,
    owner,
    { TransactionType: 'VaultDelete', Account: owner.classicAddress, VaultID: vaultId },
    'VaultDelete',
  );
}
