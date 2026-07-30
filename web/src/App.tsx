import { useCallback, useState } from 'react';
import { api, usePolled } from './api';
import { NavBar } from './components/NavBar';
import { FundScreen } from './screens/FundScreen';
import { LoanBookScreen } from './screens/LoanBookScreen';
import { UnderwritingScreen } from './screens/UnderwritingScreen';
import type { DealBundle, Fund, Health, Loan, Policy } from './types';

type Tab = 'fund' | 'underwriting' | 'loans';

/**
 * Three screens. Not four.
 *
 * The NAV bar sits above the tabs rather than inside any one of them, because
 * NAV per share is the thing that proves the vault accounting is real and it
 * should never be more than a glance away.
 */
export function App() {
  const [tab, setTab] = useState<Tab>('fund');
  const [nonce, setNonce] = useState(0);

  // Bumping the nonce forces the pollers to refetch immediately after a write,
  // rather than leaving the UI a poll interval behind the ledger.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const health = usePolled<Health>(useCallback(() => api.health(), [nonce]), 6000);
  const fund = usePolled<Fund>(useCallback(() => api.fund().catch(() => null as never), [nonce]), 4000);
  const loans = usePolled<Loan[]>(useCallback(() => api.loans().catch(() => [] as Loan[]), [nonce]), 4000);
  const deals = usePolled<DealBundle[]>(useCallback(() => api.deals(), []), 60_000);
  const policy = usePolled<Policy>(useCallback(() => api.policy(), []), 60_000);

  const connected = health.data?.connected ?? false;
  const fundOpen = health.data?.fundOpen ?? false;

  return (
    <div className="app">
      <header className="masthead">
        <h1>Bridge</h1>
        <span className="tagline">Real-estate bridge lending · XLS-65 vault + XLS-66 loans</span>
        <span className="spacer" />
        <span className={`chip ${connected ? 'live' : 'down'}`}>
          {connected ? '● devnet' : '○ disconnected'}
        </span>
        {health.data && (
          <span className="chip">ledger {health.data.validatedCloseTime.ripple}</span>
        )}
      </header>

      {health.error && (
        <div className="notice error">
          Cannot reach the Bridge API. Start it with <code>npm run server</code> in the project root.
          <div className="tiny dim" style={{ marginTop: 6 }}>{health.error}</div>
        </div>
      )}

      <div className="notice warn">
        <strong>Devnet only.</strong> Server-side keys, funded from the faucet. Loan terms on this
        page are real; only the <em>pacing</em> of repayment is compressed for the demo. Nothing here
        is production software.
      </div>

      {fund.data && <NavBar fund={fund.data} />}

      {!fundOpen && !health.error && (
        <div className="empty">
          <p>No fund is open.</p>
          <p className="small">
            Run <code>npm run demo</code> in the project root to open one and play the whole story,
            or <code>npm run lifecycle</code> for the version with the ledger-convention probe.
          </p>
        </div>
      )}

      {fundOpen && (
        <>
          <nav className="tabs">
            <button className={tab === 'fund' ? 'active' : ''} onClick={() => setTab('fund')}>
              Fund
            </button>
            <button className={tab === 'underwriting' ? 'active' : ''} onClick={() => setTab('underwriting')}>
              Underwriting
            </button>
            <button className={tab === 'loans' ? 'active' : ''} onClick={() => setTab('loans')}>
              Loan book{loans.data && loans.data.length > 0 ? ` (${loans.data.length})` : ''}
            </button>
          </nav>

          {tab === 'fund' && fund.data && <FundScreen fund={fund.data} onChanged={refresh} />}

          {tab === 'underwriting' && (
            <UnderwritingScreen
              deals={deals.data ?? []}
              policy={policy.data}
              onOriginated={refresh}
            />
          )}

          {tab === 'loans' && (
            <LoanBookScreen
              loans={loans.data ?? []}
              fund={fund.data}
              ledgerTime={health.data?.validatedCloseTime.ripple ?? 0}
              onChanged={refresh}
            />
          )}
        </>
      )}
    </div>
  );
}
