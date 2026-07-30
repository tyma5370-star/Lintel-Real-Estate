import { AccountSetAsfFlags } from 'xrpl';
import { DEMO_CURRENCY } from '../config';
import { iou } from '../ledger/amounts';
import { withClient } from '../ledger/client';
import { iouBalance, xrpBalance } from '../ledger/read';
import { submit } from '../ledger/submit';
import { loadWallets } from '../ledger/wallets';
import { updateState } from '../store';
import { heading, info, money, ok, step, table, tx, warn } from './console';

/**
 * Bootstrap the demo stablecoin.
 *
 * Three things have to be true before anyone can deposit into an IOU vault:
 *
 *   1. The issuer has `asfDefaultRipple` set. Without it balances cannot ripple
 *      between holders and deposits fail in ways that point nowhere near the
 *      actual cause.
 *   2. Every holder has a trust line to the issuer for the currency.
 *   3. Holders actually hold some.
 */

/** Generous trust limit — this is a demo stablecoin, not a risk position. */
const TRUST_LIMIT = '100000000';

/**
 * Target balances, not amounts to issue.
 *
 * Bootstrap tops each holder *up to* its target rather than issuing a fixed sum,
 * so it is safe to re-run. That matters because a completed demo leaves the LPs
 * down by whatever the default cost them, and the next run needs them solvent
 * again without re-provisioning wallets.
 */
const TARGET_BALANCE = {
  lp: 750_000,
  lp2: 250_000,
  broker: 200_000, // first-loss capital, plus headroom
  borrower: 50_000, // enough to service payments out of pocket
} as const;

async function main(): Promise<void> {
  await withClient(async (client) => {
    const w = loadWallets();

    heading('Bootstrapping the demo USD IOU');
    info(`Issuer: ${w.issuer.classicAddress}`);

    step(1, 'AccountSet — enable Default Ripple on the issuer');
    const accountSet = await submit(
      client,
      w.issuer,
      {
        TransactionType: 'AccountSet',
        Account: w.issuer.classicAddress,
        SetFlag: AccountSetAsfFlags.asfDefaultRipple,
      },
      'AccountSet (asfDefaultRipple)',
    );
    tx('Default Ripple enabled', accountSet.hash, accountSet.explorer);

    step(2, `TrustSet — trust lines to the issuer for ${DEMO_CURRENCY}`);
    for (const role of ['broker', 'lp', 'lp2', 'borrower'] as const) {
      const result = await submit(
        client,
        w[role],
        {
          TransactionType: 'TrustSet',
          Account: w[role].classicAddress,
          LimitAmount: iou(TRUST_LIMIT, w.issuer.classicAddress),
        },
        `TrustSet ${role}`,
      );
      tx(`${role} trusts issuer for ${DEMO_CURRENCY}`, result.hash, result.explorer);
    }

    step(3, 'Payment — top each participant up to its target balance');
    for (const [role, target] of Object.entries(TARGET_BALANCE) as Array<
      [keyof typeof TARGET_BALANCE, number]
    >) {
      const current = await iouBalance(client, w[role].classicAddress, w.issuer.classicAddress);
      const shortfall = target - current;

      if (shortfall <= 0.01) {
        info(`${role} already holds ${money(current)} against a ${money(target)} target — skipping.`);
        continue;
      }

      const result = await submit(
        client,
        w.issuer,
        {
          TransactionType: 'Payment',
          Account: w.issuer.classicAddress,
          Destination: w[role].classicAddress,
          Amount: iou(shortfall, w.issuer.classicAddress),
        },
        `Payment ${shortfall.toFixed(2)} ${DEMO_CURRENCY} -> ${role}`,
      );
      tx(`Topped ${role} up by ${money(shortfall)} to ${money(target)}`, result.hash, result.explorer);
    }

    updateState((state) => {
      state.issuer = w.issuer.classicAddress;
    });

    heading('GATE 0 exit condition — balances');
    const rows: Array<[string, string]> = [];
    for (const role of ['issuer', 'broker', 'lp', 'lp2', 'borrower'] as const) {
      const usd = await iouBalance(client, w[role].classicAddress, w.issuer.classicAddress);
      const xrp = await xrpBalance(client, w[role].classicAddress);
      rows.push([role, `${money(usd).padStart(14)} ${DEMO_CURRENCY}   ${xrp.toFixed(2)} XRP`]);
    }
    table(rows);
    console.log('');

    const lpBalance = await iouBalance(client, w.lp.classicAddress, w.issuer.classicAddress);
    if (lpBalance > 0) {
      ok(`GATE 0 PASSED — LP holds ${money(lpBalance)} ${DEMO_CURRENCY} from our issuer.`);
      info('Next: npm run lifecycle');
    } else {
      warn('LP balance is zero — the vault deposit will fail. Check the trust lines above.');
      process.exitCode = 1;
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
