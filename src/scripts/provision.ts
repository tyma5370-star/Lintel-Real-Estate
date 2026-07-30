import { explorerAccount, NETWORK_URL, WALLETS_FILE } from '../config';
import { withClient } from '../ledger/client';
import { ROLES, saveWallets, walletsExist, type Role, type WalletFile } from '../ledger/wallets';
import { heading, info, ok, table, warn } from './console';
import { resetState } from '../store';

/**
 * Fund the role wallets from the Devnet faucet.
 *
 * Five wallets. The second LP is not decoration: with two depositors you can show
 * that a default is shared *proportionally* rather than landing on whoever
 * happened to be holding, which is the entire point of vault share accounting.
 */
const PURPOSE: Record<Role, string> = {
  issuer: 'Issues the demo USD stablecoin IOU',
  broker: 'Vault owner + LoanBroker owner (the fund manager)',
  lp: 'Limited partner — primary depositor',
  lp2: 'Limited partner — second depositor, proves proportional loss sharing',
  borrower: 'Property sponsor taking the bridge loan',
};

async function main(): Promise<void> {
  if (walletsExist() && process.argv[2] !== '--force') {
    warn(`${WALLETS_FILE} already exists. Re-run with --force to replace it (existing on-chain objects will be orphaned).`);
    info('Prefer `npm run teardown` first, so the old vault and broker are cleaned up properly.');
    return;
  }

  await withClient(async (client) => {
    heading('Provisioning role wallets');
    info(`Faucet: ${NETWORK_URL}`);

    const wallets = {} as WalletFile;

    for (const role of ROLES) {
      const { wallet, balance } = await client.fundWallet();
      wallets[role] = { address: wallet.classicAddress, seed: wallet.seed! };
      ok(`${role.padEnd(9)} ${wallet.classicAddress}  ${balance} XRP`);
      info(`${' '.repeat(10)}${PURPOSE[role]}`);
      info(`${' '.repeat(10)}${explorerAccount(wallet.classicAddress)}`);
    }

    saveWallets(wallets);
    resetState(NETWORK_URL);

    heading('Summary');
    table(ROLES.map((role) => [role, wallets[role].address]));
    console.log('');
    ok(`Seeds written to ${WALLETS_FILE} (gitignored).`);
    warn('These are server-side devnet keys. Never point this project at Testnet or Mainnet.');
    info('Next: npm run bootstrap');
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
