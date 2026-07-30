import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { duration, gradeClass, money, money0, pct, ratio, shortId, tenthBps } from '../format';
import type { DealBundle, DealInput, OnChainTerms, Policy, Underwriting } from '../types';

interface Props {
  deals: DealBundle[];
  policy: Policy | null;
  onOriginated: () => void;
}

/** Numeric fields, grouped the way a credit memo is laid out. */
const FIELDS: Array<{ group: string; items: Array<{ key: keyof DealInput; label: string; step?: string; hint?: string }> }> = [
  {
    group: 'Basis',
    items: [
      { key: 'purchasePrice', label: 'Purchase price' },
      { key: 'rehabBudget', label: 'Rehab budget' },
      { key: 'asIsValue', label: 'As-is value' },
      { key: 'afterRepairValue', label: 'After-repair value (ARV)' },
    ],
  },
  {
    group: 'Stabilised income',
    items: [
      { key: 'monthlyGrossRent', label: 'Monthly gross rent' },
      { key: 'vacancyRate', label: 'Vacancy rate', step: '0.01', hint: 'decimal — 7% is 0.07' },
      { key: 'monthlyTaxes', label: 'Monthly taxes' },
      { key: 'monthlyInsurance', label: 'Monthly insurance' },
      { key: 'monthlyHOA', label: 'Monthly HOA', hint: 'do not leave at 0 unless there is genuinely none' },
      { key: 'maintenanceReserveRate', label: 'Maintenance reserve', step: '0.01', hint: 'share of EGI' },
      { key: 'managementFeeRate', label: 'Management fee', step: '0.01', hint: 'share of EGI' },
    ],
  },
  {
    group: 'Structure and sponsor',
    items: [
      { key: 'termMonths', label: 'Term (months)' },
      { key: 'sponsorLiquidity', label: 'Sponsor liquidity' },
      { key: 'sponsorPriorDeals', label: 'Sponsor prior deals' },
    ],
  },
];

export function UnderwritingScreen({ deals, policy, onOriginated }: Props) {
  const [selectedId, setSelectedId] = useState<string>(deals[0]?.input.id ?? '');
  const [deal, setDeal] = useState<DealInput | null>(deals[0]?.input ?? null);
  const [result, setResult] = useState<Underwriting | null>(deals[0]?.underwriting ?? null);
  const [onChain, setOnChain] = useState<OnChainTerms | null>(deals[0]?.onChainTerms ?? null);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originating, setOriginating] = useState(false);
  const [originated, setOriginated] = useState<{ hash: string; explorer: string } | null>(null);

  // Re-score on every edit. The engine is pure and takes microseconds, so there
  // is no reason to make the user press a button to see what they just changed.
  useEffect(() => {
    if (!deal) return;
    let cancelled = false;
    setScoring(true);
    const timer = setTimeout(async () => {
      try {
        const response = await api.underwrite(deal);
        if (cancelled) return;
        setResult(response.underwriting);
        setOnChain(response.onChainTerms as OnChainTerms | null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setScoring(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deal]);

  const grades = policy?.grades;
  const metrics = result?.metrics;

  const selectDeal = (id: string) => {
    const bundle = deals.find((d) => d.input.id === id);
    if (!bundle) return;
    setSelectedId(id);
    setDeal(bundle.input);
    setResult(bundle.underwriting);
    setOnChain(bundle.onChainTerms);
    setOriginated(null);
  };

  const setField = (key: keyof DealInput, raw: string) => {
    setDeal((current) => {
      if (!current) return current;
      const value = key === 'exitStrategy' || key === 'id' || key === 'address' ? raw : Number(raw);
      return { ...current, [key]: value } as DealInput;
    });
    setOriginated(null);
  };

  const alreadyOriginated = useMemo(
    () => deals.find((d) => d.input.id === selectedId) !== undefined && originated !== null,
    [deals, selectedId, originated],
  );

  async function originate() {
    if (!deal) return;
    setOriginating(true);
    setError(null);
    try {
      const response = await api.originate(deal);
      if (!response.approved) {
        setError('Declined by the engine — see the reasons below. Nothing was submitted.');
        setResult(response.underwriting);
      } else if (response.hash && response.explorer) {
        setOriginated({ hash: response.hash, explorer: response.explorer });
        onOriginated();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOriginating(false);
    }
  }

  if (!deal) return <div className="empty">No deals loaded.</div>;

  return (
    <>
      <div className="panel">
        <h2>Deal</h2>
        <div className="actions" style={{ marginBottom: 12 }}>
          {deals.map((bundle) => (
            <button
              key={bundle.input.id}
              className={`action ${bundle.input.id === selectedId ? 'primary' : ''}`}
              onClick={() => selectDeal(bundle.input.id)}
            >
              {bundle.input.id} · {bundle.underwriting.decision.grade}
            </button>
          ))}
        </div>
        <div className="field">
          <label>Address</label>
          <input value={deal.address} onChange={(e) => setField('address', e.target.value)} />
        </div>
        <div className="field">
          <label>Exit strategy</label>
          <select value={deal.exitStrategy} onChange={(e) => setField('exitStrategy', e.target.value)}>
            <option value="refinance">refinance</option>
            <option value="sale">sale</option>
          </select>
        </div>
      </div>

      <div className="grid three">
        {FIELDS.map((group) => (
          <div className="panel" key={group.group}>
            <h2>{group.group}</h2>
            {group.items.map((field) => (
              <div className="field" key={String(field.key)}>
                <label>{field.label}</label>
                <input
                  value={String(deal[field.key] ?? '')}
                  step={field.step}
                  inputMode="decimal"
                  onChange={(e) => setField(field.key, e.target.value)}
                />
                {field.hint && <div className="hint">{field.hint}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {error && <div className="notice error">{error}</div>}

      {result && metrics && (
        <>
          <div className="grid two">
            <div className="panel">
              <h2>Computed metrics {scoring && <span className="dim">· scoring…</span>}</h2>
              <div className="kv"><span className="k">Total project cost</span><span className="v">{money(metrics.totalProjectCost)}</span></div>
              <div className="kv"><span className="k">Effective gross income</span><span className="v">{money(metrics.effectiveGrossIncome)}</span></div>
              <div className="kv"><span className="k">Operating expenses</span><span className="v">{money(metrics.operatingExpenses)}</span></div>
              <div className="kv em"><span className="k">Net operating income</span><span className="v">{money(metrics.netOperatingIncome)}</span></div>
              <div className="kv"><span className="k">LTC</span><span className="v">{pct(metrics.ltc)}</span></div>
              <div className="kv"><span className="k">ARV-LTV</span><span className="v">{pct(metrics.arvLtv)}</span></div>
              <div className="kv"><span className="k">DSCR (interest-only)</span><span className="v">{ratio(metrics.dscr)}</span></div>
              <div className="kv"><span className="k">Debt yield</span><span className="v">{pct(metrics.debtYield)}</span></div>
              <div className="kv"><span className="k">Exit coverage</span><span className="v">{ratio(metrics.exitCoverage)}</span></div>
              <div className="kv"><span className="k">Advance at close</span><span className="v">{money(metrics.initialAdvance)} ({pct(metrics.advanceLtvAsIs)} of as-is)</span></div>
              <div className="kv"><span className="k">Rehab holdback</span><span className="v">{money(metrics.rehabHoldback)}</span></div>
              <div className="kv"><span className="k">Sponsor equity required</span><span className="v">{money(metrics.equityRequired)}</span></div>
            </div>

            <div className="panel">
              <h2>Sizing — the loan is the minimum across every constraint</h2>
              {result.sizing.constraints.map((constraint) => {
                const binding = constraint.name === result.sizing.bindingConstraint;
                return (
                  <div className={`constraint-row ${binding ? 'binding' : ''}`} key={constraint.name}>
                    <span className="marker">{binding ? '→' : ''}</span>
                    <span className="amount">{money0(constraint.maxLoan)}</span>
                    <span className="desc">{constraint.description}</span>
                  </div>
                );
              })}
              <div className="kv em" style={{ marginTop: 12 }}>
                <span className="k">Loan amount</span>
                <span className="v">{money(result.sizing.loanAmount)}</span>
              </div>
              <div className="kv">
                <span className="k">Bound by</span>
                <span className="v">{result.sizing.bindingConstraint}</span>
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Decision</h2>
            {result.decision.approved && result.terms ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <span className={`badge ${gradeClass(result.decision.grade)}`}>GRADE {result.decision.grade}</span>
                  <span className="up mono">APPROVED</span>
                  <span className="muted small">{grades?.[result.decision.grade]?.label}</span>
                </div>
                <div className="grid two">
                  <div>
                    <div className="kv"><span className="k">Rate</span><span className="v">{result.terms.annualRatePercent.toFixed(2)}% annual, interest-only</span></div>
                    <div className="kv"><span className="k">Term</span><span className="v">{result.terms.termMonths} months</span></div>
                    <div className="kv"><span className="k">Monthly interest</span><span className="v">{money(result.terms.monthlyPayment)}</span></div>
                    <div className="kv"><span className="k">Balloon at exit</span><span className="v">{money(result.terms.balloonAtExit)}</span></div>
                  </div>
                  <div>
                    <div className="kv"><span className="k">Origination fee</span><span className="v">{money(result.terms.originationFee)}</span></div>
                    <div className="kv"><span className="k">Servicing / payment</span><span className="v">{money(result.terms.servicingFee)}</span></div>
                    <div className="kv"><span className="k">Total interest</span><span className="v">{money(result.terms.totalInterest)}</span></div>
                    <div className="kv"><span className="k">Required first-loss cover</span><span className="v">{result.terms.requiredCoverPercent}%</span></div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <span className={`badge ${gradeClass(result.decision.grade)}`}>GRADE {result.decision.grade}</span>
                  <span className="down mono">DECLINED</span>
                </div>
                <div className="notice error" style={{ marginBottom: 0 }}>
                  {result.decision.declineReasons.map((reason, i) => (
                    <div key={i} style={{ marginBottom: i === result.decision.declineReasons.length - 1 ? 0 : 8 }}>
                      · {reason}
                    </div>
                  ))}
                </div>
                <p className="tiny dim" style={{ marginTop: 12, marginBottom: 0 }}>
                  Every ratio floor is enforced by <em>sizing</em>, so a sized loan satisfies them by
                  construction. Proceeds adequacy is the constraint sizing cannot satisfy — shrinking
                  the loan is precisely what breaks it — which is why a decline is possible at all.
                </p>
              </>
            )}
          </div>

          {result.decision.approved && onChain && (
            <div className="panel">
              <h2>XLS-66 LoanSet fields — what actually goes on the ledger</h2>
              <div className="grid two">
                <div>
                  <div className="kv"><span className="k">PrincipalRequested</span><span className="v">{onChain.principalRequested}</span></div>
                  <div className="kv"><span className="k">InterestRate</span><span className="v">{onChain.interestRate} <span className="dim">({tenthBps(onChain.interestRate)})</span></span></div>
                  <div className="kv"><span className="k">PaymentTotal</span><span className="v">{onChain.paymentTotal}</span></div>
                  <div className="kv"><span className="k">PaymentInterval</span><span className="v">{onChain.paymentInterval}s <span className="dim">({duration(onChain.paymentInterval)})</span></span></div>
                  <div className="kv"><span className="k">GracePeriod</span><span className="v">{onChain.gracePeriod}s</span></div>
                  <div className="kv"><span className="k">Flags</span><span className="v">{onChain.allowOverpayment ? 'tfLoanOverpayment' : '0'}</span></div>
                </div>
                <div>
                  <div className="kv"><span className="k">LoanOriginationFee</span><span className="v">{onChain.loanOriginationFee}</span></div>
                  <div className="kv"><span className="k">LoanServiceFee</span><span className="v">{onChain.loanServiceFee}</span></div>
                  <div className="kv"><span className="k">LatePaymentFee</span><span className="v">{onChain.latePaymentFee}</span></div>
                  <div className="kv"><span className="k">ClosePaymentFee</span><span className="v">{onChain.closePaymentFee}</span></div>
                  <div className="kv"><span className="k">LateInterestRate</span><span className="v">{onChain.lateInterestRate} <span className="dim">({tenthBps(onChain.lateInterestRate)})</span></span></div>
                  <div className="kv"><span className="k">Expected PeriodicPayment</span><span className="v">{money(onChain.compression.expectedPeriodicPayment)}</span></div>
                </div>
              </div>

              <div className="notice warn" style={{ marginTop: 14 }}>
                <strong>Demo disclosure.</strong> {onChain.compression.note}
              </div>

              <div className="actions">
                <button className="action primary" disabled={originating || alreadyOriginated} onClick={originate}>
                  {originating ? 'Submitting dual-signed LoanSet…' : 'Approve and originate'}
                </button>
                {originated && (
                  <a className="action" href={originated.explorer} target="_blank" rel="noreferrer" style={{ lineHeight: '2.1' }}>
                    {shortId(originated.hash, 12)} ↗
                  </a>
                )}
              </div>
              {originated && (
                <div className="notice good" style={{ marginTop: 12, marginBottom: 0 }}>
                  Originated. The borrower signed first, the manager counter-signed, and the combined
                  blob was submitted unmodified. Principal moved on success — there is no draw step.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {policy && (
        <div className="panel">
          <h2>The credit box</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Grade</th>
                  <th className="right">Spread</th>
                  <th className="right">Required cover</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {(['A', 'B', 'C', 'D'] as const).map((grade) => (
                  <tr key={grade}>
                    <td><span className={`badge ${gradeClass(grade)}`}>{grade}</span></td>
                    <td className="num">+{policy.grades[grade].spreadPercent.toFixed(1)}%</td>
                    <td className="num">{policy.grades[grade].requiredCoverPercent}%</td>
                    <td className="muted">{policy.grades[grade].label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny dim" style={{ marginTop: 10, marginBottom: 0 }}>
            Base rate {policy.policy.baseRatePercent}% · max ARV-LTV {pct(policy.policy.maxArvLtv, 0)} ·
            max LTC {pct(policy.policy.maxLtc, 0)} · min DSCR {policy.policy.minDscr.toFixed(2)}x ·
            min debt yield {pct(policy.policy.minDebtYield, 0)} · min exit coverage{' '}
            {policy.policy.minExitCoverage.toFixed(2)}x · min viable LTC {pct(policy.policy.minViableLtc, 0)}.
            A SHA-256 of this policy is written into the vault's on-ledger Data field.
          </p>
        </div>
      )}
    </>
  );
}
