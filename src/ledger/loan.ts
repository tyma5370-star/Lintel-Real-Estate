import type { Client, Wallet } from 'xrpl';
import { convertStringToHex, LoanManageFlags, LoanPayFlags, LoanSetFlags, signLoanSetByCounterparty } from 'xrpl';
import { DEMO_CURRENCY } from '../config';
import { money, moneyCeil } from '../units';
import { iou } from './amounts';
import { getLoan, validatedCloseTime, type LoanView } from './read';
import { createdEntryId, submit, submitSignedBlob, type SubmitResult } from './submit';

/** XLS-66 — LoanSet (dual-signed), LoanPay, LoanManage, LoanDelete. */

/**
 * The on-chain loan terms, in protocol units.
 *
 * Every rate here is already in 1/10 basis points and every amount is already a
 * decimal string. Producing this object is the underwriting engine's job
 * (see src/underwriting/terms.ts); this module only submits it.
 */
export interface LoanSetTerms {
  principalRequested: string;
  interestRate: number;
  paymentTotal: number;
  paymentInterval: number;
  gracePeriod: number;
  loanOriginationFee: string;
  loanServiceFee: string;
  latePaymentFee: string;
  closePaymentFee: string;
  overpaymentFee: number;
  lateInterestRate: number;
  closeInterestRate: number;
  overpaymentInterestRate: number;
  /** Allow principal-reducing overpayments. Must ALSO be flagged on each LoanPay. */
  allowOverpayment: boolean;
  /** Optional on-ledger reference to the deal, ≤ 512 hex chars. */
  note?: string;
}

export interface OriginatedLoan {
  loanId: string;
  submit: SubmitResult;
}

/**
 * Originate a loan with a dual-signed `LoanSet`.
 *
 * Signing order — this is the part that is easy to get wrong, and the ordering
 * in most write-ups is backwards for xrpl.js v5:
 *
 *   1. `Account` (the borrower) autofills and signs. This produces `TxnSignature`
 *      and `SigningPubKey`.
 *   2. `Counterparty` (the broker owner) calls `signLoanSetByCounterparty`, which
 *      *requires* step 1 to have happened already and throws
 *      "Transaction must be first signed by first party" otherwise.
 *   3. The resulting blob is submitted as-is. It must NOT be re-signed.
 *
 * `CounterpartySignature` is marked `isSigningField: false` in the binary codec,
 * so it is excluded from the signing payload. Both parties therefore sign the
 * identical canonical payload; neither signature covers the other. That is why
 * the order above works, and why re-signing at step 3 would discard the
 * counterparty's signature.
 *
 * There is no `LoanDraw`. Principal moves to the borrower on successful `LoanSet`.
 */
export async function originateLoan(
  client: Client,
  borrower: Wallet,
  brokerOwner: Wallet,
  brokerId: string,
  terms: LoanSetTerms,
): Promise<OriginatedLoan> {
  const flags = terms.allowOverpayment ? LoanSetFlags.tfLoanOverpayment : 0;

  const tx = {
    TransactionType: 'LoanSet' as const,
    Account: borrower.classicAddress,
    Counterparty: brokerOwner.classicAddress,
    LoanBrokerID: brokerId,
    PrincipalRequested: terms.principalRequested,
    InterestRate: terms.interestRate,
    PaymentTotal: terms.paymentTotal,
    PaymentInterval: terms.paymentInterval,
    GracePeriod: terms.gracePeriod,
    LoanOriginationFee: terms.loanOriginationFee,
    LoanServiceFee: terms.loanServiceFee,
    LatePaymentFee: terms.latePaymentFee,
    ClosePaymentFee: terms.closePaymentFee,
    OverpaymentFee: terms.overpaymentFee,
    LateInterestRate: terms.lateInterestRate,
    CloseInterestRate: terms.closeInterestRate,
    OverpaymentInterestRate: terms.overpaymentInterestRate,
    Flags: flags,
    ...(terms.note ? { Data: convertStringToHex(terms.note) } : {}),
  };

  const prepared = await client.autofill(tx as never);
  const borrowerSigned = borrower.sign(prepared);
  const dualSigned = signLoanSetByCounterparty(brokerOwner, borrowerSigned.tx_blob);

  const result = await submitSignedBlob(client, dualSigned.tx_blob, 'LoanSet (dual-signed)');
  return { loanId: createdEntryId(result.meta, 'Loan'), submit: result };
}

export interface PaymentDue {
  amount: string;
  isLate: boolean;
  flags: number;
  /** Breakdown, for narration. */
  breakdown: {
    periodicPayment: number;
    serviceFee: number;
    latePaymentFee: number;
    lateInterest: number;
  };
}

/**
 * Compute the exact amount owed for the next installment.
 *
 * Measured against the latest **validated ledger close time**, never the local
 * system clock — a few seconds of drift puts the amount under the ledger's
 * threshold and the transaction fails for reasons that look nothing like a clock
 * problem.
 *
 * A late payment must be for an exact amount and does not accept overpayment, so
 * the late branch rounds *up* to the cent: paying a cent over is ignored, paying
 * a cent under is rejected.
 */
export async function computePaymentDue(client: Client, loan: LoanView): Promise<PaymentDue> {
  const { ripple: now } = await validatedCloseTime(client);
  const isLate = now > loan.nextPaymentDueDate;

  const periodicPayment = loan.periodicPayment;
  const serviceFee = loan.loanServiceFee;

  if (!isLate) {
    // Round UP, always.
    //
    // `PeriodicPayment` carries far more precision than cents — 11180.03304066…
    // on a $127,500 loan — and the ledger requires at least the exact figure.
    // Rounding to the nearest cent rounds *down* about half the time, and a
    // third of a cent short is rejected with `tecINSUFFICIENT_PAYMENT`, which
    // names nothing about rounding. Paying a fraction of a cent over is safe:
    // without `tfLoanOverpayment` on this transaction the excess is ignored.
    return {
      amount: moneyCeil(periodicPayment + serviceFee),
      isLate: false,
      flags: 0,
      breakdown: { periodicPayment, serviceFee, latePaymentFee: 0, lateInterest: 0 },
    };
  }

  // Late interest accrues on the overdue balance for the overdue duration.
  // The ledger is authoritative on the exact figure; this is a client-side
  // reconstruction and is rounded up so it can only ever be at or above the
  // ledger's threshold.
  const overdueSeconds = now - loan.nextPaymentDueDate;
  const periodsOverdue = loan.paymentInterval > 0 ? overdueSeconds / loan.paymentInterval : 0;
  const lateInterest = (loan.principalOutstanding * (loan.lateInterestRate / 100_000) * periodsOverdue) || 0;
  const latePaymentFee = loan.latePaymentFee;

  return {
    amount: moneyCeil(periodicPayment + serviceFee + latePaymentFee + lateInterest),
    isLate: true,
    flags: LoanPayFlags.tfLoanLatePayment,
    breakdown: { periodicPayment, serviceFee, latePaymentFee, lateInterest },
  };
}

/** Make a single installment payment, on time or late as the ledger clock dictates. */
export async function payInstallment(
  client: Client,
  borrower: Wallet,
  loanId: string,
  issuer: string,
  currency = DEMO_CURRENCY,
): Promise<{ submit: SubmitResult; due: PaymentDue }> {
  const loan = await getLoan(client, loanId);
  const due = await computePaymentDue(client, loan);

  const result = await submit(
    client,
    borrower,
    {
      TransactionType: 'LoanPay',
      Account: borrower.classicAddress,
      LoanID: loanId,
      Amount: iou(due.amount, issuer, currency),
      Flags: due.flags,
    },
    `LoanPay ${due.amount} ${currency}${due.isLate ? ' (late)' : ''}`,
  );

  return { submit: result, due };
}

/**
 * Pay the loan off early in full.
 *
 * `CloseInterestRate` and `ClosePaymentFee` govern the payoff, so the amount is
 * not simply `TotalValueOutstanding`. We send the outstanding total plus the
 * close fee and a close-interest allowance; the ledger takes what it needs.
 */
export async function repayInFull(
  client: Client,
  borrower: Wallet,
  loanId: string,
  issuer: string,
  currency = DEMO_CURRENCY,
): Promise<SubmitResult> {
  const loan = await getLoan(client, loanId);

  // CloseInterestRate is charged on the principal being retired early, in place
  // of the interest the remaining schedule would have earned. Rates are 1/10 bps,
  // so divide by 100_000 to get a fraction.
  const closeInterest = loan.principalOutstanding * (loan.closeInterestRate / 100_000);
  const payoff = loan.totalValueOutstanding + closeInterest + loan.closePaymentFee + loan.loanServiceFee;

  return submit(
    client,
    borrower,
    {
      TransactionType: 'LoanPay',
      Account: borrower.classicAddress,
      LoanID: loanId,
      Amount: iou(moneyCeil(payoff), issuer, currency),
      Flags: LoanPayFlags.tfLoanFullPayment,
    },
    'LoanPay (full payoff)',
  );
}

/**
 * Repay every remaining installment.
 *
 * Installments are paid ahead of their due dates rather than by waiting out each
 * interval, which keeps the demo inside its time budget while still exercising
 * the on-time path (no late flag, no late fee). The loan is re-read from the
 * ledger between payments — `PeriodicPayment` and `PrincipalOutstanding` both
 * move, and paying a stale amount fails.
 */
export async function repayOnSchedule(
  client: Client,
  borrower: Wallet,
  loanId: string,
  issuer: string,
  currency = DEMO_CURRENCY,
  onPayment?: (index: number, remaining: number, result: SubmitResult, due: PaymentDue) => void,
): Promise<SubmitResult[]> {
  const results: SubmitResult[] = [];
  let guard = 0;

  for (;;) {
    const loan = await getLoan(client, loanId);
    if (loan.paymentRemaining <= 0) break;
    if (++guard > 64) throw new Error(`repayOnSchedule: loan ${loanId} did not amortise within 64 payments`);

    const { submit: result, due } = await payInstallment(client, borrower, loanId, issuer, currency);
    results.push(result);
    onPayment?.(guard, loan.paymentRemaining, result, due);
  }

  return results;
}

/**
 * Flag a loan as impaired — the protocol's watchlist.
 *
 * Impairment pulls `NextPaymentDueDate` forward to the moment of impairment,
 * which means the loan becomes defaultable one grace period later instead of
 * waiting out the original schedule. It clears itself if the borrower pays
 * before that date, so it is a reversible signal rather than a write-off.
 */
export async function impairLoan(client: Client, brokerOwner: Wallet, loanId: string): Promise<SubmitResult> {
  return submit(
    client,
    brokerOwner,
    {
      TransactionType: 'LoanManage',
      Account: brokerOwner.classicAddress,
      LoanID: loanId,
      Flags: LoanManageFlags.tfLoanImpair,
    },
    'LoanManage (impair)',
  );
}

export async function unimpairLoan(client: Client, brokerOwner: Wallet, loanId: string): Promise<SubmitResult> {
  return submit(
    client,
    brokerOwner,
    {
      TransactionType: 'LoanManage',
      Account: brokerOwner.classicAddress,
      LoanID: loanId,
      Flags: LoanManageFlags.tfLoanUnimpair,
    },
    'LoanManage (unimpair)',
  );
}

/**
 * Default the loan. First-loss cover absorbs what it can, up to
 * `CoverRateLiquidation` of the required cover; the remainder lands on the
 * vault as unrealized loss and therefore on LP NAV per share.
 */
export async function defaultLoan(client: Client, brokerOwner: Wallet, loanId: string): Promise<SubmitResult> {
  return submit(
    client,
    brokerOwner,
    {
      TransactionType: 'LoanManage',
      Account: brokerOwner.classicAddress,
      LoanID: loanId,
      Flags: LoanManageFlags.tfLoanDefault,
    },
    'LoanManage (default)',
  );
}

export async function deleteLoan(client: Client, account: Wallet, loanId: string): Promise<SubmitResult> {
  return submit(
    client,
    account,
    { TransactionType: 'LoanDelete', Account: account.classicAddress, LoanID: loanId },
    'LoanDelete',
  );
}

/**
 * Wait until the validated ledger clock passes `rippleTime`.
 *
 * Polls the validated ledger rather than sleeping a wall-clock duration, because
 * Devnet close times are what the protocol checks against and they do not
 * advance at exactly one second per second.
 *
 * Transient request failures are tolerated. This loop runs for a minute or more
 * against a public Devnet node, which is long enough for a single request to time
 * out or the websocket to drop — and letting that kill the caller means a
 * teardown dies halfway through, leaving objects stranded on the ledger and the
 * next run unable to start. A dropped poll is not a reason to give up; it is a
 * reason to reconnect and poll again.
 */
export async function waitForLedgerTime(
  client: Client,
  rippleTime: number,
  onTick?: (secondsRemaining: number) => void,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let consecutiveFailures = 0;

  for (;;) {
    try {
      const { ripple: now } = await validatedCloseTime(client);
      consecutiveFailures = 0;
      if (now >= rippleTime) return;
      onTick?.(rippleTime - now);
    } catch (error) {
      if (++consecutiveFailures >= 10) {
        throw new Error(
          `waitForLedgerTime: ${consecutiveFailures} consecutive failures polling the validated ledger — ` +
            `last error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Most likely a dropped socket. Reconnecting is cheap and idempotent.
      try {
        if (!client.isConnected()) await client.connect();
      } catch {
        /* next tick will try again */
      }
    }

    if (Date.now() > deadline) {
      throw new Error(
        `waitForLedgerTime: gave up after 10 minutes waiting for ledger time ${rippleTime}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}
