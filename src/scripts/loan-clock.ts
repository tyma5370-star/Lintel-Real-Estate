import { withClient } from '../ledger/client';
import { getLoan, validatedCloseTime } from '../ledger/read';
import { loadState } from '../store';
import { info, table } from './console';

/** Where each loan sits against the validated ledger clock. Diagnoses tecTOO_SOON. */
async function main(): Promise<void> {
  await withClient(async (client) => {
    const { ripple: now } = await validatedCloseTime(client);
    info(`Validated ledger close time: ${now}`);

    for (const record of loadState().loans) {
      const loan = await getLoan(client, record.loanId);
      const defaultableAt = loan.nextPaymentDueDate + loan.gracePeriod;
      table([
        ['deal', record.dealId],
        ['paymentInterval', `${loan.paymentInterval}s`],
        ['gracePeriod', `${loan.gracePeriod}s`],
        ['startDate', String(loan.startDate)],
        ['nextPaymentDueDate', `${loan.nextPaymentDueDate}  (${now - loan.nextPaymentDueDate}s ago)`],
        ['defaultable at', `${defaultableAt}  ${now > defaultableAt ? 'PASSED' : `in ${defaultableAt - now}s`}`],
        ['paymentRemaining', String(loan.paymentRemaining)],
        ['impaired / defaulted', `${loan.impaired} / ${loan.defaulted}`],
      ]);
      console.log('');
    }
  });
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
