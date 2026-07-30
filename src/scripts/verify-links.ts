import { explorerTx } from '../config';
import { withClient } from '../ledger/client';
import { loadTxLog } from '../store';
import { fail, heading, info, ok } from './console';

/**
 * Confirm that the explorer links quoted in the README still resolve.
 *
 * Transaction hashes are permanent on the ledger even after teardown deletes the
 * objects they created, so they are safe to publish — but "safe in principle" is
 * not the same as "checked", and a dead link in a graded README is worse than no
 * link at all.
 */
const HASHES: Array<[string, string]> = [
  ['VaultCreate', 'E83B8B66B796BE62AEEA1C31BE43A393752CC4672FD4208DF1F9C1350F67D539'],
  ['LoanBrokerSet', '4CB6109AE2E02286C5164D2CDE07589E1AFF811FD68A27AF6A35F4860876EF3D'],
  ['LoanSet (dual-signed)', '75C13ADB66F961DB1F34527CDC0E4408D84A02C1439A4CEDA8CB0F96DDF6344D'],
  ['LoanPay', 'FC9AFACB81D759310D30627CFB845A8319EC87ACF46E47FC9E6E4408272AE6D0'],
  ['LoanManage impair', '6278CC65A86A5969AD32799EBB2EBBACF250216841D9788903952494D8B8CA7A'],
  ['LoanManage default', '2A9A0EF10C7C9C686947C9451B3DEAA9688B44ACC42BF2A43B6A4CB1E5A206FE'],
];

async function main(): Promise<void> {
  await withClient(async (client) => {
    heading('Verifying README explorer links');
    let bad = 0;

    for (const [label, hash] of HASHES) {
      try {
        const response = (await client.request({
          command: 'tx',
          transaction: hash,
        } as never)) as unknown as {
          result: { meta?: unknown; tx_json: { TransactionType: string }; ledger_index: number };
        };
        const meta = response.result.meta;
        const engine =
          typeof meta === 'object' && meta !== null
            ? (meta as { TransactionResult?: string }).TransactionResult
            : 'unknown';
        ok(`${label.padEnd(22)} ${response.result.tx_json.TransactionType.padEnd(14)} ${engine}  ledger ${response.result.ledger_index}`);
        info(`${' '.repeat(23)}${explorerTx(hash)}`);
      } catch (error) {
        bad++;
        fail(`${label.padEnd(22)} ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('');
    if (bad === 0) ok(`All ${HASHES.length} links resolve on Devnet.`);
    else {
      fail(`${bad} link(s) do not resolve — do not publish them.`);
      process.exitCode = 1;
    }

    info(`(${loadTxLog().length} transactions in the local log)`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
