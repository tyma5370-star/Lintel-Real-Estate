import { withClient } from '../ledger/client';
import { computeNav } from '../ledger/nav';
import { getBroker, getVault } from '../ledger/read';
import { loadState } from '../store';
import { heading, info, money, table, warn } from './console';

/**
 * Dump current on-ledger state for everything this project has created.
 *
 * Raw ledger entries, not our interpretation of them — this is the tool for
 * answering "what does the ledger actually say" when a computed figure looks
 * wrong. Pass `--raw` to include the unprocessed JSON.
 */
async function main(): Promise<void> {
  const raw = process.argv.includes('--raw');

  await withClient(async (client) => {
    const state = loadState();

    if (state.vaultId) {
      heading('Vault');
      const vault = await getVault(client, state.vaultId);
      const nav = computeNav(vault);
      table([
        ['Vault ID', vault.vaultId],
        ['Pseudo-account', vault.account],
        ['Share MPT', vault.shareMptId],
        ['Scale', String(vault.scale)],
        ['Assets total', money(vault.assetsTotal)],
        ['Assets available', money(vault.assetsAvailable)],
        ['Loss unrealized', money(vault.lossUnrealized)],
        ['Shares outstanding', vault.sharesOutstanding.toString()],
        ['NAV per share', nav.navPerShare.toFixed(6)],
        ['Deposit rate / share', nav.depositRatePerShare.toFixed(6)],
        ['Redemption rate / share', nav.redemptionRatePerShare.toFixed(6)],
      ]);
    }

    if (state.brokerId) {
      heading('LoanBroker');
      const broker = await getBroker(client, state.brokerId);
      table([
        ['Broker ID', broker.brokerId],
        ['Pseudo-account', broker.account],
        ['Debt outstanding', money(broker.debtTotal)],
        ['Debt maximum', money(broker.debtMaximum)],
        ['Cover available', money(broker.coverAvailable)],
        ['Cover required', money(broker.coverRequired)],
        ['Cover ratio', broker.coverRatio === Infinity ? 'n/a (no debt)' : `${broker.coverRatio.toFixed(2)}x`],
        ['Management fee rate', `${broker.managementFeeRate} tenth-bps`],
        ['Cover rate minimum', `${broker.coverRateMinimum} tenth-bps`],
        ['Cover rate liquidation', `${broker.coverRateLiquidation} tenth-bps`],
        ['Origination', broker.originationBlocked ? 'BLOCKED' : 'permitted'],
      ]);
    }

    for (const record of state.loans) {
      heading(`Loan · ${record.dealId} (${record.status})`);
      try {
        const response = (await client.request({
          command: 'ledger_entry',
          index: record.loanId,
          ledger_index: 'validated',
        })) as unknown as { result: { node: Record<string, unknown> } };
        const node = response.result.node;

        info(`Submitted: InterestRate=${record.onChain.interestRate} tenth-bps · ` +
          `PaymentTotal=${record.onChain.paymentTotal} · PaymentInterval=${record.onChain.paymentInterval}s`);
        console.log('');
        table(
          Object.entries(node)
            .filter(([key]) => key !== 'PreviousTxnID' && key !== 'index')
            .map(([key, value]) => [key, String(value)]),
        );
        if (raw) console.log(JSON.stringify(node, null, 2));
      } catch {
        warn('Entry no longer on the ledger (deleted).');
      }
    }

    if (!state.vaultId && state.loans.length === 0) {
      info('Nothing recorded in data/state.json.');
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
