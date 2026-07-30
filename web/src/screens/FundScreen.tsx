import { useState } from 'react';
import { api } from '../api';
import { money, nav as fmtNav, pct, ratio, shortId } from '../format';
import type { Fund } from '../types';

interface Props {
  fund: Fund;
  onChanged: () => void;
}

const ROLE_LABEL: Record<string, string> = { lp: 'LP', lp2: 'LP2' };

/** Screen 1 — the depositor's view of the fund. */
export function FundScreen({ fund, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: string; explorer: string } | null>(null);
  const [depositRole, setDepositRole] = useState('lp');
  const [depositAmount, setDepositAmount] = useState('100000');
  const [withdrawRole, setWithdrawRole] = useState('lp');
  const [withdrawShares, setWithdrawShares] = useState('50000');

  async function run(label: string, fn: () => Promise<{ hash: string; explorer: string }>) {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      setResult(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const cover = fund.cover;

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {result && (
        <div className="notice good">
          Submitted — <a href={result.explorer} target="_blank" rel="noreferrer">{shortId(result.hash, 12)}</a>
        </div>
      )}

      <div className="grid two">
        <div className="panel">
          <h2>Vault</h2>
          <div className="kv em">
            <span className="k">Assets total</span>
            <span className="v">{money(fund.nav.assetsTotal)}</span>
          </div>
          <div className="kv">
            <span className="k">Available to lend</span>
            <span className="v">{money(fund.nav.assetsAvailable)}</span>
          </div>
          <div className="kv">
            <span className="k">Deployed in loans</span>
            <span className="v">{money(fund.nav.assetsTotal - fund.nav.assetsAvailable)}</span>
          </div>
          <div className="kv">
            <span className="k">Unrealized loss</span>
            <span className={`v ${fund.nav.lossUnrealized > 0 ? 'down' : ''}`}>
              {money(fund.nav.lossUnrealized)}
            </span>
          </div>
          <div className="kv em">
            <span className="k">Net assets</span>
            <span className="v">{money(fund.nav.netAssets)}</span>
          </div>
          <div className="kv">
            <span className="k">Shares outstanding</span>
            <span className="v">{fund.nav.sharesOutstanding.toLocaleString('en-US')}</span>
          </div>
          <div className="kv em">
            <span className="k">NAV per share</span>
            <span className="v">{fmtNav(fund.nav.navPerShare)}</span>
          </div>
          <p className="tiny dim" style={{ marginTop: 12, marginBottom: 0 }}>
            Vault <a href={fund.vault.explorer} target="_blank" rel="noreferrer">{shortId(fund.vault.account, 10)}</a>{' '}
            · scale 10<sup>{fund.vault.scale}</sup> · shares are an MPT minted by the vault itself.
          </p>
        </div>

        <div className="panel">
          <h2>First-loss capital</h2>
          {cover ? (
            <>
              <div className="kv em">
                <span className="k">Cover available</span>
                <span className="v">{money(cover.available)}</span>
              </div>
              <div className="kv">
                <span className="k">Cover required ({cover.minimumPercent}% of debt)</span>
                <span className="v">{money(cover.required)}</span>
              </div>
              <div className="kv">
                <span className="k">Cover ratio</span>
                <span className={`v ${cover.ratio !== null && cover.ratio < 1 ? 'down' : 'up'}`}>
                  {cover.ratio === null ? '— (no debt)' : ratio(cover.ratio)}
                </span>
              </div>
              <div className="kv">
                <span className="k">Debt outstanding</span>
                <span className="v">{money(cover.debtOutstanding)}</span>
              </div>
              <div className="kv">
                <span className="k">Debt maximum</span>
                <span className="v">{money(cover.debtMaximum)}</span>
              </div>
              <div className="kv">
                <span className="k">Origination</span>
                <span className={`v ${cover.originationBlocked ? 'down' : 'up'}`}>
                  {cover.originationBlocked ? 'BLOCKED' : 'permitted'}
                </span>
              </div>

              <div className="notice warn" style={{ marginTop: 14, marginBottom: 0 }}>
                A single default draws at most <strong>{cover.liquidationPercent}% of the required
                cover</strong> — not of the cover available. The manager holds{' '}
                {money(cover.available)}, but only {money(cover.required)} of it stands behind the
                current book.
              </div>
            </>
          ) : (
            <p className="muted">No loan broker registered.</p>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Limited partner positions</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Partner</th>
                <th>Address</th>
                <th className="right">Shares</th>
                <th className="right">Ownership</th>
                <th className="right">Position value</th>
              </tr>
            </thead>
            <tbody>
              {fund.positions.map((position, i) => (
                <tr key={position.address}>
                  <td>{ROLE_LABEL[i === 0 ? 'lp' : 'lp2'] ?? `LP${i + 1}`}</td>
                  <td className="mono tiny dim">{shortId(position.address, 10)}</td>
                  <td className="num">{position.sharesScaled.toLocaleString('en-US')}</td>
                  <td className="num">{pct(position.ownership)}</td>
                  <td className="num">{money(position.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tiny dim" style={{ marginTop: 10, marginBottom: 0 }}>
          A default is shared in proportion to holdings, not borne by whoever happens to be holding.
          Two depositors exist precisely so that is visible.
        </p>
      </div>

      <div className="grid two">
        <div className="panel">
          <h2>Subscribe</h2>
          <div className="field">
            <label>Partner</label>
            <select value={depositRole} onChange={(e) => setDepositRole(e.target.value)}>
              <option value="lp">LP</option>
              <option value="lp2">LP2</option>
            </select>
          </div>
          <div className="field">
            <label>Amount (demo USD)</label>
            <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} inputMode="decimal" />
            <div className="hint">
              Priced at the deposit rate, {fund.nav.depositRatePerShare.toFixed(6)} per share.
            </div>
          </div>
          <button
            className="action primary"
            disabled={busy !== null || !(Number(depositAmount) > 0)}
            onClick={() => run('deposit', () => api.deposit(depositRole, Number(depositAmount)))}
          >
            {busy === 'deposit' ? 'Submitting…' : 'VaultDeposit'}
          </button>
        </div>

        <div className="panel">
          <h2>Redeem</h2>
          <div className="field">
            <label>Partner</label>
            <select value={withdrawRole} onChange={(e) => setWithdrawRole(e.target.value)}>
              <option value="lp">LP</option>
              <option value="lp2">LP2</option>
            </select>
          </div>
          <div className="field">
            <label>Shares</label>
            <input value={withdrawShares} onChange={(e) => setWithdrawShares(e.target.value)} inputMode="decimal" />
            <div className="hint">
              Priced at the redemption rate, {fund.nav.redemptionRatePerShare.toFixed(6)} per share —
              net of unrealized loss.
            </div>
          </div>
          <button
            className="action"
            disabled={busy !== null || !(Number(withdrawShares) > 0)}
            onClick={() =>
              run('withdraw', () =>
                api.withdraw(
                  withdrawRole,
                  Math.round(Number(withdrawShares) * 10 ** fund.vault.scale),
                ),
              )
            }
          >
            {busy === 'withdraw' ? 'Submitting…' : 'VaultWithdraw'}
          </button>
        </div>
      </div>

      {fund.navHistory.length > 0 && (
        <div className="panel">
          <h2>NAV per share — the whole story in one column</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="right">NAV / share</th>
                  <th className="right">Change</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {fund.navHistory.map((point, i) => {
                  const previous = i > 0 ? fund.navHistory[i - 1]!.navPerShare : point.navPerShare;
                  const delta = point.navPerShare - previous;
                  const cls = delta > 1e-9 ? 'up' : delta < -1e-9 ? 'down' : 'dim';
                  return (
                    <tr key={`${point.at}-${i}`}>
                      <td className="num">{fmtNav(point.navPerShare)}</td>
                      <td className={`num ${cls}`}>
                        {i === 0 ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(6)}`}
                      </td>
                      <td className="muted">{point.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="tiny dim" style={{ marginTop: 10, marginBottom: 0 }}>
            Every figure is read back from the ledger after the write that caused it. Nothing here is
            rendered from local cache.
          </p>
        </div>
      )}
    </>
  );
}
