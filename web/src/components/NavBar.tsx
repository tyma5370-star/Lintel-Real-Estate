import { money, nav as fmtNav } from '../format';
import type { Fund } from '../types';
import { Sparkline } from './Sparkline';

/**
 * The one number that must be on screen at all times.
 *
 * NAV per share is the narrative spine: it rises when interest is paid and falls
 * when a loan is impaired or defaults, and it does so without anyone telling it
 * to. This component is rendered above the tabs on every screen, so it is never
 * more than a glance away regardless of what you are looking at.
 *
 * Both exchange rates are shown. The protocol prices deposits and redemptions
 * differently — deposits on gross assets so a new depositor does not buy into a
 * loss they were not present for, redemptions on current value — and neither
 * rate is queryable from the ledger. Almost nobody displays both.
 */
export function NavBar({ fund }: { fund: Fund }) {
  const history = fund.navHistory.map((p) => p.navPerShare);
  const series = history.length > 0 ? history : [fund.nav.navPerShare];
  const first = series[0]!;
  const current = fund.nav.navPerShare;
  const delta = current - first;

  const direction = delta > 1e-9 ? 'up' : delta < -1e-9 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '·';
  const ratesDiverge = Math.abs(fund.nav.depositRatePerShare - fund.nav.redemptionRatePerShare) > 1e-9;

  return (
    <div className="navbar">
      <div className="primary">
        <div className="label">NAV per share</div>
        <div className="value">{fmtNav(current)}</div>
        <div className={`delta ${direction}`}>
          {arrow} {delta >= 0 ? '+' : ''}
          {delta.toFixed(6)} since inception
        </div>
      </div>

      <Sparkline values={series} />

      <div className="metric">
        <div className="label">Net assets</div>
        <div className="value">{money(fund.nav.netAssets)}</div>
      </div>
      <div className="metric">
        <div className="label">Available</div>
        <div className="value">{money(fund.nav.assetsAvailable)}</div>
      </div>
      <div className="metric">
        <div className="label">Unrealized loss</div>
        <div className={`value ${fund.nav.lossUnrealized > 0 ? 'down' : ''}`}>
          {money(fund.nav.lossUnrealized)}
        </div>
      </div>
      <div className="metric">
        <div className="label">Shares</div>
        <div className="value">{fund.nav.sharesOutstanding.toLocaleString('en-US')}</div>
      </div>
      <div className="metric" title="Deposits are priced on gross assets; redemptions on current value.">
        <div className="label">Deposit / redeem</div>
        <div className="value">
          {fund.nav.depositRatePerShare.toFixed(4)} / {fund.nav.redemptionRatePerShare.toFixed(4)}
          {ratesDiverge && <span className="warn"> ⚠</span>}
        </div>
      </div>
    </div>
  );
}
