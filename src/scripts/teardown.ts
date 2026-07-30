import { withClient } from '../ledger/client';
import { deleteBroker, withdrawCover } from '../ledger/broker';
import { defaultLoan, deleteLoan, impairLoan, waitForLedgerTime } from '../ledger/loan';
import { entryExists, getBroker, getLoan, getVault, iouBalance, mptBalance } from '../ledger/read';
import { deleteVault, withdrawFromVault } from '../ledger/vault';
import { shares } from '../ledger/amounts';
import { loadWallets } from '../ledger/wallets';
import { loadState, updateState } from '../store';
import { heading, info, ok, step, tx, warn } from './console';

/**
 * Teardown, in the only order that works.
 *
 *     for each loan:  LoanManage(tfLoanDefault) -> LoanDelete
 *     redeem LP shares
 *     LoanBrokerCoverWithdraw
 *     LoanBrokerDelete
 *     VaultDelete
 *
 * Any deviation surfaces as `tecHAS_OBLIGATIONS`, which names the symptom rather
 * than the cause. Written early and deliberately idempotent, because it gets run
 * dozens of times while iterating and a broken teardown means provisioning fresh
 * wallets on every attempt.
 *
 * A loan can only be deleted once it is closed — either fully repaid or defaulted.
 * Anything still active gets defaulted first; that is destructive, which is fine
 * for a devnet teardown and would not be fine anywhere else.
 */
async function main(): Promise<void> {
  await withClient(async (client) => {
    const w = loadWallets();
    const state = loadState();

    heading('Teardown');

    if (!state.vaultId && state.loans.length === 0) {
      info('Nothing recorded in data/state.json — nothing to tear down.');
      return;
    }

    // ── 1. Close and delete every loan ───────────────────────────────────
    step(1, 'Loans — default anything still active, then delete');
    for (const record of state.loans) {
      if (!(await entryExists(client, record.loanId))) {
        info(`${record.dealId} (${record.loanId.slice(0, 12)}…) already gone.`);
        continue;
      }

      let loan = await getLoan(client, record.loanId);
      const isClosed = loan.defaulted || loan.paymentRemaining === 0;

      if (!isClosed) {
        warn(`${record.dealId} is still active — defaulting it so it can be deleted.`);

        // A loan cannot be defaulted straight from active, even when it is already
        // past NextPaymentDueDate + GracePeriod: that returns tecTOO_SOON.
        // tfLoanDefault requires the loan to be IMPAIRED first, and then one grace
        // period to elapse from the impairment. Impairment is what pulls the due
        // date forward to now, which is what starts that clock.
        if (!loan.impaired) {
          const impaired = await impairLoan(client, w.broker, record.loanId);
          tx(`LoanManage tfLoanImpair · ${record.dealId}`, impaired.hash, impaired.explorer);
          loan = await getLoan(client, record.loanId);
        }

        const defaultableAt = loan.nextPaymentDueDate + loan.gracePeriod;
        await waitForLedgerTime(client, defaultableAt + 1, (remaining) =>
          info(`waiting ${remaining}s for the grace period to expire…`),
        );

        const result = await defaultLoan(client, w.broker, record.loanId);
        tx(`LoanManage tfLoanDefault · ${record.dealId}`, result.hash, result.explorer);
      }

      const deleted = await deleteLoan(client, w.broker, record.loanId);
      tx(`LoanDelete · ${record.dealId}`, deleted.hash, deleted.explorer);
      record.status = 'deleted';
    }
    updateState((s) => {
      s.loans = state.loans;
    });

    if (!state.vaultId) {
      ok('Loans cleared. No vault recorded.');
      return;
    }

    // ── 2. Redeem LP shares ──────────────────────────────────────────────
    // VaultDelete requires zero outstanding shares.
    step(2, 'Redeem all LP shares');
    if (await entryExists(client, state.vaultId)) {
      const vault = await getVault(client, state.vaultId);
      for (const role of ['lp', 'lp2'] as const) {
        const held = await mptBalance(client, w[role].classicAddress, vault.shareMptId);
        if (held === 0n) {
          info(`${role} holds no shares.`);
          continue;
        }
        const result = await withdrawFromVault(
          client,
          w[role],
          state.vaultId,
          shares(vault.shareMptId, held),
        );
        tx(`VaultWithdraw · ${role} redeemed ${held} shares`, result.hash, result.explorer);
      }
    }

    // ── 3. Withdraw first-loss cover ─────────────────────────────────────
    step(3, 'Withdraw remaining first-loss cover');
    if (state.brokerId && (await entryExists(client, state.brokerId))) {
      const broker = await getBroker(client, state.brokerId);
      if (broker.coverAvailable > 0) {
        const result = await withdrawCover(
          client,
          w.broker,
          state.brokerId,
          broker.coverAvailable,
          w.issuer.classicAddress,
        );
        tx(`LoanBrokerCoverWithdraw ${broker.coverAvailable}`, result.hash, result.explorer);
      } else {
        info('Cover pool is empty.');
      }

      // ── 4. Delete the broker ───────────────────────────────────────────
      step(4, 'LoanBrokerDelete');
      const result = await deleteBroker(client, w.broker, state.brokerId);
      tx('LoanBrokerDelete', result.hash, result.explorer);
    } else {
      info('No LoanBroker recorded or it is already gone.');
    }

    // ── 5. Delete the vault ──────────────────────────────────────────────
    step(5, 'VaultDelete');
    if (await entryExists(client, state.vaultId)) {
      const result = await deleteVault(client, w.broker, state.vaultId);
      tx('VaultDelete', result.hash, result.explorer);
    } else {
      info('Vault already gone.');
    }

    updateState((s) => {
      s.vaultId = undefined;
      s.vaultAccount = undefined;
      s.shareMptId = undefined;
      s.brokerId = undefined;
      s.brokerAccount = undefined;
      s.loans = [];
    });

    heading('Final balances');
    for (const role of ['broker', 'lp', 'lp2', 'borrower'] as const) {
      const usd = await iouBalance(client, w[role].classicAddress, w.issuer.classicAddress);
      info(`${role.padEnd(9)} $${usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    }

    console.log('');
    ok('Teardown complete — no tecHAS_OBLIGATIONS.');
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
