import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, STATE_FILE, TXLOG_FILE } from './config';
import type { DealInput, Underwriting } from './underwriting/types';
import type { OnChainTerms } from './underwriting/terms';

/**
 * JSON persistence (decision D5).
 *
 * This file holds *identifiers and off-chain artefacts only*: object ids, deal
 * inputs, and underwriting outputs. It never holds balances, NAV, or loan state.
 * The ledger is the source of truth for all of that, and every read path in
 * src/ledger/read.ts goes back to the network rather than to this file.
 */

export interface LoanRecord {
  loanId: string;
  dealId: string;
  borrower: string;
  originationHash: string;
  /** Real-world terms the underwriting engine produced. */
  underwriting: Underwriting;
  /** Compressed on-chain representation actually submitted. */
  onChain: OnChainTerms;
  status: 'active' | 'repaid' | 'impaired' | 'defaulted' | 'deleted';
}

export interface DealRecord {
  dealId: string;
  input: DealInput;
  underwriting: Underwriting;
}

export interface State {
  network: string;
  issuer?: string;
  vaultId?: string;
  vaultAccount?: string;
  shareMptId?: string;
  vaultScale?: number;
  brokerId?: string;
  brokerAccount?: string;
  deals: DealRecord[];
  loans: LoanRecord[];
  /** Observed interest-rate basis, written by the lifecycle probe. */
  interestRateBasis?: 'per-period' | 'annual' | 'inconclusive';
  navHistory: Array<{ at: string; navPerShare: number; note: string }>;
}

export interface TxLogEntry {
  label: string;
  type: string;
  hash: string;
  result: string;
  at: string;
}

const EMPTY: State = {
  network: '',
  deals: [],
  loans: [],
  navHistory: [],
};

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function loadState(): State {
  ensureDir();
  return { ...EMPTY, ...readJson<State>(STATE_FILE, EMPTY) };
}

export function saveState(state: State): void {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function updateState(mutate: (state: State) => void): State {
  const state = loadState();
  mutate(state);
  saveState(state);
  return state;
}

export function resetState(network: string): State {
  const fresh: State = { ...EMPTY, network, deals: [], loans: [], navHistory: [] };
  saveState(fresh);
  return fresh;
}

export function loadTxLog(): TxLogEntry[] {
  ensureDir();
  return readJson<TxLogEntry[]>(TXLOG_FILE, []);
}

export function appendTx(entry: TxLogEntry): void {
  ensureDir();
  const log = loadTxLog();
  log.push(entry);
  writeFileSync(TXLOG_FILE, JSON.stringify(log, null, 2));
}

export function recordNav(navPerShare: number, note: string): void {
  updateState((state) => {
    state.navHistory.push({ at: new Date().toISOString(), navPerShare, note });
  });
}
