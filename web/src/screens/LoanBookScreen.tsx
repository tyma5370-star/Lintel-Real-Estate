import { useState } from 'react';
import { api } from '../api';
import { duration, gradeClass, money, shortId, tenthBps } from '../format';
import type { Fund, Loan } from '../types';

interface Props {
  loans: Loan[];
  fund: Fund | null;
  /** Validated ledger close time — the only clock that matters for due dates. */
  ledgerTime: number;
  onChanged: () => void;
}

/** Screen 3 — the manager's loan book, with the servicing actions. */
export function LoanBookScreen({ loans, fund, ledgerTime, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: string; explorer: string } | null>(null);

  async function run(key: string, fn: () => Promise<{ hash: string; explorer: string }>) {
    setBusy(key);
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

  if (loans.length === 0) {
    return (
      <div className="empty">
        <p>No loans originated yet.</p>
        <p className="small">
          Originate one from the <strong>Underwriting</strong> tab, or run <code>npm run demo</code>{' '}
          for the whole story.
        </p>
      </div>
    );
  }

  const cover = fund?.cover;

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {result && (
        <div className="notice good">
          Submitted — <a href={result.explorer} target="_blank" rel="noreferrer">{shortId(result.hash, 12)}</a>
        </div>
      )}

      {cover && (
        <div className={`notice ${cover.originationBlocked ? 'error' : 'info'}`}>
          <strong>Cover {cover.originationBlocked ? 'SHORTFALL' : 'position'}:</strong>{' '}
          {money(cover.available)} available against {money(cover.required)} required
          ({cover.minimumPercent}% of {money(cover.debtOutstanding)} outstanding debt).{' '}
          {cover.originationBlocked
            ? 'Origination is blocked and all fees are being diverted into the cover pool until the shortfall is made good.'
            : 'Origination permitted.'}
        </div>
      )}

      {loans.map((loan) => {
        const ledger = loan.onLedger;
        const disclosure = loan.disclosure;
        const secondsToDefaultable = ledger ? ledger.defaultableAt - ledgerTime : 0;

        return (
          <div className="panel" key={loan.loanId}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <span className={`badge ${gradeClass(loan.grade)}`}>{loan.grade}</span>
              <strong>{loan.dealId}</strong>
              <span className="muted small">{loan.address}</span>
              <span className={`status ${loan.status}`}>{loan.status}</span>
              <span style={{ flex: 1 }} />
              <a className="tiny mono" href={loan.explorer} target="_blank" rel="noreferrer">
                {shortId(loan.originationHash, 10)} ↗
              </a>
            </div>

            {!ledger ? (
              <p className="muted small">Loan entry has been deleted from the ledger.</p>
            ) : (
              <>
                <div className="grid three">
                  <div>
                    <div className="kv em">
                      <span className="k">Principal outstanding</span>
                      <span className="v">{money(ledger.principalOutstanding)}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Total value outstanding</span>
                      <span className="v">{money(ledger.totalValueOutstanding)}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Periodic payment</span>
                      <span className="v">{money(ledger.periodicPayment)}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Payments remaining</span>
                      <span className="v">{ledger.paymentRemaining} of {loan.onChainTerms.paymentTotal}</span>
                    </div>
                  </div>

                  <div>
                    <div className="kv">
                      <span className="k">Interest rate</span>
                      <span className="v">{tenthBps(ledger.interestRate)} annual</span>
                    </div>
                    <div className="kv">
                      <span className="k">Payment interval</span>
                      <span className="v">{duration(ledger.paymentInterval)}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Grace period</span>
                      <span className="v">
                        {duration(ledger.gracePeriod)}
                        {disclosure.graceShortened && <span className="warn"> (demo)</span>}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">Days past due</span>
                      <span className={`v ${ledger.daysPastDue > 0 ? 'down' : ''}`}>
                        {ledger.daysPastDue > 0 ? ledger.daysPastDue.toFixed(2) : '—'}
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="kv">
                      <span className="k">Impaired</span>
                      <span className={`v ${ledger.impaired ? 'warn' : ''}`}>{ledger.impaired ? 'YES' : 'no'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Defaulted</span>
                      <span className={`v ${ledger.defaulted ? 'down' : ''}`}>{ledger.defaulted ? 'YES' : 'no'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Defaultable</span>
                      <span className="v">
                        {ledger.defaulted
                          ? '—'
                          : !ledger.impaired
                            ? 'needs impairment first'
                            : secondsToDefaultable > 0
                              ? `in ${secondsToDefaultable}s`
                              : 'now'}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">Borrower</span>
                      <span className="v tiny">{shortId(ledger.borrower, 8)}</span>
                    </div>
                  </div>
                </div>

                <p className="tiny dim" style={{ margin: '12px 0 0' }}>{ledger.scheduleLabel}</p>

                <div className="actions" style={{ marginTop: 14 }}>
                  <button
                    className="action"
                    disabled={busy !== null || ledger.defaulted || ledger.paymentRemaining === 0}
                    onClick={() => run(`${loan.loanId}-pay`, () => api.pay(loan.loanId))}
                  >
                    {busy === `${loan.loanId}-pay` ? 'Paying…' : 'LoanPay — one installment'}
                  </button>

                  {!ledger.impaired ? (
                    <button
                      className="action warn"
                      disabled={busy !== null || ledger.defaulted}
                      onClick={() => run(`${loan.loanId}-impair`, () => api.impair(loan.loanId))}
                    >
                      {busy === `${loan.loanId}-impair` ? 'Impairing…' : 'Impair — move to watchlist'}
                    </button>
                  ) : (
                    <button
                      className="action"
                      disabled={busy !== null || ledger.defaulted}
                      onClick={() => run(`${loan.loanId}-unimpair`, () => api.unimpair(loan.loanId))}
                    >
                      {busy === `${loan.loanId}-unimpair` ? 'Unimpairing…' : 'Unimpair — reverse the provision'}
                    </button>
                  )}

                  <button
                    className="action danger"
                    disabled={busy !== null || ledger.defaulted || !ledger.defaultableNow}
                    title={
                      !ledger.impaired
                        ? 'A loan must be impaired before it can be defaulted, or the ledger returns tecTOO_SOON.'
                        : secondsToDefaultable > 0
                          ? `Grace period expires in ${secondsToDefaultable}s.`
                          : 'Default this loan.'
                    }
                    onClick={() => run(`${loan.loanId}-default`, () => api.default(loan.loanId))}
                  >
                    {busy === `${loan.loanId}-default` ? 'Defaulting…' : 'Default'}
                  </button>
                </div>

                {ledger.impaired && !ledger.defaulted && (
                  <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
                    Impairment has written the <strong>full outstanding balance</strong> down as
                    unrealized loss — not an expected-loss estimate. It reverses if the borrower pays
                    before the due date, which is what makes it a watchlist rather than a write-off.
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="panel">
        <h2>Demo disclosure</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          On-chain terms are the <strong>real</strong> terms — real payment interval, real payment
          count, real annual rate. The demo compresses only the <em>pacing</em>: installments are
          prepaid rather than waited out, which does not change the interest because{' '}
          <code className="mono">PeriodicPayment</code> is fixed at origination.
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          The one genuine deviation is <code className="mono">GracePeriod</code>, held at its
          60-second floor rather than a real month so an impaired loan can be defaulted inside the
          demo. Compressing the interval instead was ruled out: the ledger prorates interest by
          interval-in-seconds, so a 120-second "month" charges roughly five cents of interest on a
          $127,500 loan, and the 100% rate ceiling makes it uncorrectable.
        </p>
      </div>
    </>
  );
}
