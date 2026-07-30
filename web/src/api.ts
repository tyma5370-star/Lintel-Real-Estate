import { useCallback, useEffect, useRef, useState } from 'react';
import type { DealBundle, DealInput, Fund, Health, Loan, Policy, TxLogEntry, Underwriting } from './types';

/**
 * API client.
 *
 * Every read here goes to the ledger via the server — there is no client-side
 * cache of balances or loan state, and after any write the caller refreshes
 * rather than patching local state optimistically. The ledger is the source of
 * truth and the UI is deliberately a thin view over it.
 */

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new ApiError((body as { error?: string })?.error ?? `${path} failed with ${response.status}`);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/health'),
  fund: () => request<Fund>('/fund'),
  loans: () => request<Loan[]>('/loans'),
  deals: () => request<DealBundle[]>('/deals'),
  policy: () => request<Policy>('/policy'),
  transactions: () => request<TxLogEntry[]>('/transactions'),

  underwrite: (deal: DealInput) =>
    request<{ underwriting: Underwriting; onChainTerms: unknown }>('/underwrite', {
      method: 'POST',
      body: JSON.stringify(deal),
    }),

  originate: (deal: DealInput) =>
    request<{ approved: boolean; loanId?: string; hash?: string; explorer?: string; underwriting: Underwriting }>(
      '/originate',
      { method: 'POST', body: JSON.stringify(deal) },
    ),

  deposit: (role: string, amount: number) =>
    request<{ hash: string; explorer: string }>('/deposit', {
      method: 'POST',
      body: JSON.stringify({ role, amount }),
    }),

  withdraw: (role: string, shares: number) =>
    request<{ hash: string; explorer: string }>('/withdraw', {
      method: 'POST',
      body: JSON.stringify({ role, shares }),
    }),

  cover: (amount: number) =>
    request<{ hash: string; explorer: string }>('/cover', { method: 'POST', body: JSON.stringify({ amount }) }),

  pay: (loanId: string) =>
    request<{ hash: string; explorer: string }>(`/loans/${loanId}/pay`, { method: 'POST' }),

  impair: (loanId: string) =>
    request<{ hash: string; explorer: string }>(`/loans/${loanId}/impair`, { method: 'POST' }),

  unimpair: (loanId: string) =>
    request<{ hash: string; explorer: string }>(`/loans/${loanId}/unimpair`, { method: 'POST' }),

  default: (loanId: string) =>
    request<{ hash: string; explorer: string }>(`/loans/${loanId}/default`, { method: 'POST' }),
};

/**
 * Poll an endpoint on an interval.
 *
 * Polling rather than websockets is the right call here: Devnet ledgers close
 * every few seconds, the data set is tiny, and a poll cannot drift out of sync
 * with the ledger the way a subscription with a missed message can.
 */
export function usePolled<T>(
  fetcher: () => Promise<T>,
  intervalMs = 4000,
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void load();
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load, intervalMs]);

  return { data, error, loading, refresh: load };
}
