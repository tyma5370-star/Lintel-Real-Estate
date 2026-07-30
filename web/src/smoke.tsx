import { renderToString } from 'react-dom/server';
import { NavBar } from './components/NavBar';
import { FundScreen } from './screens/FundScreen';
import { LoanBookScreen } from './screens/LoanBookScreen';
import { UnderwritingScreen } from './screens/UnderwritingScreen';
import type { DealBundle, Fund, Health, Loan, Policy } from './types';

/**
 * Render smoke test.
 *
 * A passing `vite build` proves the code compiles; it does not prove a component
 * survives contact with a real API payload. This fetches live data from the
 * running server and renders every screen to a string, so a crash in a render
 * path — a missing field, an undefined index, a bad map — fails here instead of
 * as a blank page in front of a judge.
 *
 * Run the API first, then:  npx tsx web/src/smoke.tsx
 */

const BASE = process.env.LINTEL_API ?? 'http://localhost:8787';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`);
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

function check(name: string, html: string, mustContain: string[]): void {
  const missing = mustContain.filter((needle) => !html.includes(needle));
  if (missing.length > 0) {
    throw new Error(`${name} rendered but is missing: ${missing.join(', ')}`);
  }
  console.log(`  ok  ${name.padEnd(20)} ${html.length.toLocaleString()} chars`);
}

async function main(): Promise<void> {
  console.log(`Smoke-testing screens against ${BASE}\n`);

  const health = await get<Health>('/health');
  if (!health.fundOpen) {
    console.error('No fund is open. Run `npm run lifecycle` or `npm run demo` first.');
    process.exit(1);
  }

  const [fund, loans, deals, policy] = await Promise.all([
    get<Fund>('/fund'),
    get<Loan[]>('/loans'),
    get<DealBundle[]>('/deals'),
    get<Policy>('/policy'),
  ]);

  check('NavBar', renderToString(<NavBar fund={fund} />), ['NAV per share', 'Deposit / redeem']);

  check('FundScreen', renderToString(<FundScreen fund={fund} onChanged={() => {}} />), [
    'Assets total',
    'NAV per share',
    'Limited partner positions',
    'VaultDeposit',
    'VaultWithdraw',
  ]);

  check(
    'UnderwritingScreen',
    renderToString(<UnderwritingScreen deals={deals} policy={policy} onOriginated={() => {}} />),
    ['Computed metrics', 'Sizing', 'The credit box'],
  );

  check(
    'LoanBookScreen',
    renderToString(
      <LoanBookScreen
        loans={loans}
        fund={fund}
        ledgerTime={health.validatedCloseTime.ripple}
        onChanged={() => {}}
      />,
    ),
    ['Demo disclosure', 'LoanPay'],
  );

  // Empty states matter too — this is what a judge sees before running the demo.
  check('LoanBook (empty)', renderToString(
    <LoanBookScreen loans={[]} fund={fund} ledgerTime={0} onChanged={() => {}} />,
  ), ['No loans originated yet']);

  console.log('\nAll screens rendered against live API data.');
  console.log(`  fund NAV/share  ${fund.nav.navPerShare.toFixed(6)}`);
  console.log(`  loans           ${loans.length}`);
  console.log(`  deals           ${deals.length}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
