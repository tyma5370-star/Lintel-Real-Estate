import type { Client, SubmittableTransaction, TxResponse, Wallet } from 'xrpl';
import { explorerTx } from '../config';
import { appendTx } from '../store';

export interface SubmitResult<T extends SubmittableTransaction = SubmittableTransaction> {
  hash: string;
  engineResult: string;
  explorer: string;
  /** Full validated transaction response, including `meta`. */
  response: TxResponse<T>;
  /** `meta` narrowed to an object — every validated tx has object metadata. */
  meta: Record<string, unknown>;
}

export class TransactionFailedError extends Error {
  constructor(
    readonly label: string,
    readonly engineResult: string,
    readonly hash: string,
  ) {
    super(`${label} failed with ${engineResult} — ${explorerTx(hash)}`);
    this.name = 'TransactionFailedError';
  }
}

/**
 * Autofill, sign, submit, and wait for validation.
 *
 * Always checks the engine result. `tesSUCCESS` is necessary but not sufficient —
 * several conditions in XLS-66 succeed while silently ignoring your intent (an
 * overpayment without the flag on both the Loan entry and the LoanPay tx being
 * the sharpest example), so callers that care must also read `meta` back.
 */
export async function submit<T extends SubmittableTransaction>(
  client: Client,
  wallet: Wallet,
  tx: T,
  label: string,
): Promise<SubmitResult<T>> {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const response = (await client.submitAndWait(signed.tx_blob)) as TxResponse<T>;
  return finish(response, label);
}

/**
 * Submit a transaction blob that is already fully signed.
 *
 * Used for dual-signed `LoanSet`, where the blob is produced by
 * `signLoanSetByCounterparty` and must not be re-signed.
 */
export async function submitSignedBlob<T extends SubmittableTransaction>(
  client: Client,
  txBlob: string,
  label: string,
): Promise<SubmitResult<T>> {
  const response = (await client.submitAndWait(txBlob)) as TxResponse<T>;
  return finish(response, label);
}

function finish<T extends SubmittableTransaction>(response: TxResponse<T>, label: string): SubmitResult<T> {
  const meta = response.result.meta;
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`${label}: validated transaction returned no object metadata`);
  }
  const engineResult = (meta as { TransactionResult?: string }).TransactionResult ?? 'unknown';
  const hash = response.result.hash;

  appendTx({
    label,
    type: response.result.tx_json.TransactionType,
    hash,
    result: engineResult,
    at: new Date().toISOString(),
  });

  if (engineResult !== 'tesSUCCESS') {
    throw new TransactionFailedError(label, engineResult, hash);
  }

  return {
    hash,
    engineResult,
    explorer: explorerTx(hash),
    response,
    meta: meta as unknown as Record<string, unknown>,
  };
}

/**
 * Pull every node of a given ledger-entry type out of transaction metadata.
 *
 * This is how we recover a `Vault`, `LoanBroker`, or `Loan` object id and its
 * post-transaction fields without a second round trip.
 */
export function affectedNodes(
  meta: Record<string, unknown>,
  entryType: string,
): Array<{ index: string; fields: Record<string, unknown>; kind: 'Created' | 'Modified' | 'Deleted' }> {
  const nodes = (meta.AffectedNodes ?? []) as Array<Record<string, any>>;
  const out: Array<{ index: string; fields: Record<string, unknown>; kind: 'Created' | 'Modified' | 'Deleted' }> = [];

  for (const node of nodes) {
    for (const kind of ['Created', 'Modified', 'Deleted'] as const) {
      const inner = node[`${kind}Node`];
      if (!inner || inner.LedgerEntryType !== entryType) continue;
      out.push({
        index: inner.LedgerIndex,
        fields: { ...(inner.PreviousFields ?? {}), ...(inner.NewFields ?? inner.FinalFields ?? {}) },
        kind,
      });
    }
  }
  return out;
}

/** The id of the single ledger entry of `entryType` created by this transaction. */
export function createdEntryId(meta: Record<string, unknown>, entryType: string): string {
  const created = affectedNodes(meta, entryType).filter((n) => n.kind === 'Created');
  if (created.length !== 1) {
    throw new Error(
      `Expected exactly one created ${entryType} entry in transaction metadata, found ${created.length}.`,
    );
  }
  return created[0]!.index;
}

export function createdEntry(meta: Record<string, unknown>, entryType: string): Record<string, unknown> {
  const created = affectedNodes(meta, entryType).filter((n) => n.kind === 'Created');
  if (created.length !== 1) {
    throw new Error(
      `Expected exactly one created ${entryType} entry in transaction metadata, found ${created.length}.`,
    );
  }
  return created[0]!.fields;
}
