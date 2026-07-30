import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Wallet } from 'xrpl';
import { DATA_DIR, WALLETS_FILE } from '../config';

export const ROLES = ['issuer', 'broker', 'lp', 'lp2', 'borrower'] as const;
export type Role = (typeof ROLES)[number];

export interface StoredWallet {
  address: string;
  seed: string;
}

export type WalletFile = Record<Role, StoredWallet>;

export function walletsExist(): boolean {
  return existsSync(WALLETS_FILE);
}

export function saveWallets(wallets: WalletFile): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

export function loadWalletFile(): WalletFile {
  if (!walletsExist()) {
    throw new Error(
      `No wallet file at ${WALLETS_FILE}. Run \`npm run provision\` first — it funds four role wallets from the Devnet faucet.`,
    );
  }
  return JSON.parse(readFileSync(WALLETS_FILE, 'utf8')) as WalletFile;
}

/**
 * Load every role wallet as a signing `Wallet`.
 *
 * Server-side keys, devnet only. This is stated plainly in the README; it is a
 * deliberate scope cut (§1.2) rather than an oversight, and nothing here should
 * ever be pointed at Testnet or Mainnet.
 */
export function loadWallets(): Record<Role, Wallet> {
  const file = loadWalletFile();
  const out = {} as Record<Role, Wallet>;
  for (const role of ROLES) {
    const stored = file[role];
    if (!stored) throw new Error(`Wallet file is missing the "${role}" role. Re-run \`npm run provision\`.`);
    out[role] = Wallet.fromSeed(stored.seed);
  }
  return out;
}

export type Wallets = Record<Role, Wallet>;
