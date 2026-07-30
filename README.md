# Lintel

**A real-estate bridge lending fund on the XRP Ledger.**

Limited partners deposit into an XLS-65 Single Asset Vault. An off-chain
underwriting engine scores each property deal — LTV, LTC, ARV-LTV, DSCR, debt
yield, exit coverage — and outputs a full set of loan terms. Those terms are
originated on-chain through the XLS-66 Lending Protocol, with the manager's
first-loss capital standing in front of the LPs when a borrower defaults.

> **Devnet only.** Server-side keys, stored in a gitignored file, funded from the
> Devnet faucet. This is a hackathon build, not production software.

---

## Why the XRPL Lending Protocol

The XRPL Lending Protocol deliberately keeps credit judgement **off**-chain and
standardises execution **on**-chain. It ships no collateral management, no
liquidation engine, and no underwriting logic.

That is not a gap to complain about — it is the extension point, and real-estate
bridge lending is the most natural thing to build into it, because bridge lending
is *exactly* a business of off-chain property underwriting plus standardised
fixed-term execution. The parts the protocol leaves out are the parts a lender's
edge actually lives in.

So this project is two halves that meet at one interface:

- **Off-chain** — a credit box, expressed as data, and an engine that sizes and
  prices a loan against it. This is `src/underwriting/`.
- **On-chain** — vault accounting, dual-signed origination, amortisation, cover
  absorption, default. This is `src/ledger/`, and it is entirely the protocol's
  work, not ours.

The interface between them is one function: `toOnChainTerms()`.

---

## Run it yourself

Requires Node 20+ (built on v24).

```bash
npm install
npm run web:install        # front-end dependencies

npm run check:amendments   # GATE 0 — are XLS-65/66 live on Devnet right now?
npm run provision          # fund five role wallets from the faucet
npm run bootstrap          # issue the demo USD IOU and set up trust lines

npm run demo               # the whole story, narrated, ~3 minutes
npm run teardown           # clean up every ledger object
```

### With the interface

Two terminals:

```bash
npm run server             # HTTP API on :8787
npm run web                # Vite dev server on :5173
```

Then open **http://localhost:5173**. The front end proxies `/api` to the server,
so there is one port to change if you move it.

The UI reads a fund that already exists — run `npm run demo` (or
`npm run lifecycle`) first to open one, and the interface will show it live. From
there you can subscribe, redeem, underwrite an arbitrary deal, originate it, and
service or default a loan directly from the screens.

### Everything else

```bash
npm test                   # 66 unit tests, no network
npm run underwrite         # the underwriting engine alone, no ledger
npm run lifecycle          # the demo plus an empirical probe of ledger conventions
npm run inspect            # dump current on-ledger state
npm run web:smoke          # render every screen against live API data
npm run web:build          # production build of the front end
npm run typecheck          # backend and front end
```

`npm run demo` refuses to start if a fund is already open, and tells you to tear
down first. `npm run bootstrap` is re-runnable — it tops each participant *up to*
a target balance, so you can run the demo repeatedly without re-provisioning.

---

## What the demo does

```
Act I    vault opens, two LPs subscribe, manager posts $120,000 first-loss capital
Act II   three deals underwritten — two approved, one declined
Act III  Cleveland loan originated, repaid over 12 installments      NAV rises
Act IV   Boulder loan originated, impaired, defaulted                NAV falls
```

The narrative spine is one number, printed after every step:

```
NAV per share — the whole story in one column

    1.000000   after LP subscriptions
    1.008242   after Cleveland repaid in full
    1.045771   after Boulder originated
    0.410556   after Boulder impaired (provision)
    0.474078   after Boulder default (realized)
```

Every one of those figures is read back from the ledger after the write that
caused it. Nothing is rendered from local cache.

That column also shows three things about the protocol that are not obvious and
are not documented — see [`docs/feedback-log.md`](docs/feedback-log.md) F7:

- NAV **rises on origination**, because the vault books the loan's full expected
  interest as a receivable immediately rather than accruing it.
- NAV **falls hard on impairment**, because impairment writes down the *entire*
  outstanding balance, not an expected-loss estimate. This loan had not yet missed
  a payment.
- NAV **recovers slightly on default**, because first-loss capital then reimburses
  part of a provision that had assumed a total loss.

### Where the loss lands

```
Boulder defaulted owing $508,475.50

  First-loss capital absorbed     $50,817.22
  LPs absorbed                   $457,355.02
  Manager cover remaining         $69,182.78

  LP   75.0% of the fund · position now $284,446.51
  LP2  25.0% of the fund · position now  $94,815.50
```

Two LPs, not one, because that is what shows a default being shared
**proportionally** rather than landing on whoever happened to be holding — which
is the entire point of vault share accounting.

Note that absorption is capped at the **required** cover (`CoverRateMinimum` x
debt), not at cover *available*. The manager held $120,000 and only $50,817 could
be drawn. A manager who over-posts cover expecting deeper protection does not get
it.

---

## Underwriting methodology

The credit box lives in [`src/underwriting/policy.ts`](src/underwriting/policy.ts)
as data, so a reader can see the policy rather than infer it from behaviour. A
SHA-256 of that file is written into the vault's on-ledger `Data` field, which
makes "we underwrote to our stated policy" verifiable rather than assertable.

### The metrics

| Metric | Definition |
| --- | --- |
| Total project cost | `purchasePrice + rehabBudget` |
| Effective gross income | `monthlyGrossRent x (1 − vacancyRate) x 12` |
| Operating expenses | taxes + insurance + HOA annualised, plus maintenance and management as a share of EGI |
| NOI | `EGI − operatingExpenses` |
| LTC | `loan / totalProjectCost` |
| ARV-LTV | `loan / afterRepairValue` |
| Advance LTV | `(loan − rehabHoldback) / asIsValue` |
| DSCR | `NOI / annualInterest` — interest-only |
| Debt yield | `NOI / loan` |
| Exit coverage | `ARV x (1 − sellingCosts) / loanPayoff` |

### Sizing

Each constraint is solved **for a maximum principal** independently, and the loan
is the **minimum** across all of them. A bridge lender binds on whichever is
tightest; taking the minimum is what makes this real rather than decorative.

Recording *which* constraint bound matters as much as the amount — it is the
sentence the borrower actually needs to hear, and on a decline it is the only
useful thing you can tell them.

| Constraint | Limit |
| --- | --- |
| ARV-LTV | 70% of after-repair value |
| LTC | 85% of total project cost |
| Advance at close | 80% of as-is value, **plus** the rehab holdback |
| DSCR | 1.20x on interest-only debt service |
| Debt yield | 9.0% floor |
| Exit coverage | 1.15x on net sale proceeds |

The as-is constraint is measured against the *advance*, not the full commitment.
Bridge loans fund in two pieces — an advance at close and a rehab holdback
released against completed work — and measuring as-is LTV against the whole
commitment would reject every deal that funds a rehab.

### Grading and pricing

| Grade | DSCR | ARV-LTV | Prior deals | Liquidity | Spread | Required cover |
| --- | --- | --- | --- | --- | --- | --- |
| A | ≥ 1.50x | ≤ 60% | ≥ 5 | ≥ 12 mo | +1.0% | 5% |
| B | ≥ 1.30x | ≤ 68% | ≥ 2 | ≥ 6 mo | +2.0% | 10% |
| C | ≥ 1.20x | ≤ 70% | ≥ 1 | ≥ 3 mo | +4.0% | 15% |
| D | — | — | — | — | +6.5% | **decline** |

Base rate 7.5%; the grade spread is added to it. Rows are evaluated in order and
the first one satisfied on *every* dimension wins. Weaker credit costs the manager
more capital, not just more basis points.

There is a circularity here — the loan amount depends on the rate via DSCR, the
rate depends on the grade, the grade depends on metrics computed at the loan
amount. The engine iterates to a fixed point rather than pretending it away by
grading off a fixed assumed rate.

### The decline path

An engine that approves everything is not an engine. **Pueblo is declined**, and
the reason is worth reading:

```
DECLINED · grade D
  · Proceeds inadequate: the dscr constraint caps the loan at 29.0% LTC, below
    the 55% minimum. The sponsor would need to fund $177,536 of a $250,000
    project. Binding constraint: DSCR floor of 1.20x on $12,174 NOI supports
    $10,145 of annual interest = $72,464 at 14.00% interest-only.
  · Grade D — Outside the credit box — decline.
```

Note *why* proceeds adequacy is the test that can actually fail. Every ratio floor
above is enforced **by sizing** — a sized loan satisfies them by construction, so
re-testing them afterwards can never fail. Proceeds adequacy is the one constraint
sizing cannot satisfy, because shrinking the loan is precisely what breaks it.

### Interest-only, and where that diverges from the protocol

The engine underwrites **interest-only with a balloon at exit**, which is what
bridge loans are. Underwriting DSCR against a fully-amortising 12-month schedule
would charge the property with repaying all its principal out of one year of NOI.

XLS-66 loans **amortise**. The protocol has no interest-only or balloon structure,
so the loan we underwrite and the loan we originate differ in this one respect. It
is disclosed here rather than hidden, and it is feedback entry F7.

---

## Demo time compression — disclosed

Real bridge loans run 6–18 months. This demo runs in three minutes.

**The terms are not compressed.** `PaymentInterval` is a real month (2,629,800s),
`PaymentTotal` is the real payment count, and `InterestRate` is the real annual
rate. The loan on the ledger is economically the loan the engine underwrote.

**Only the pacing is compressed** — installments are prepaid rather than waited
out. This is sound because an early payment is an on-time payment and
`PeriodicPayment` is fixed at origination, so paying early does not reduce the
interest charged.

**Why not just shrink the interval**, which is the obvious approach? Because we
verified that the ledger reads `InterestRate` as an *annualised* rate and charges
each period `rate x PaymentInterval / year`. Interest is a function of the interval
in **seconds**, so compressing a month to 120 seconds compresses the interest by
the same 22,000x factor — and it cannot be corrected by raising the rate, because
`InterestRate` is capped at 100%.

Measured, not theorised: at a compressed 240-second period, a $127,500 loan
charged **$0.0538** of total interest across its entire life. The same loan with
real terms charges **$6,655.77**. The first number cannot demonstrate a lending
protocol; the second can.

**The one genuine deviation:** `GracePeriod` is held at its 60-second floor rather
than a real month, so an impaired loan can be defaulted inside the demo. This is
flagged in the terms object as `compression.graceShortened`, and printed in the
narration.

---

## The interface

Three screens. Not four.

**Fund** (LP view) — vault assets, available versus deployed, unrealized loss, net
assets, shares outstanding, LP positions with ownership and current value, the
first-loss cover position against its requirement, subscribe and redeem, and the
full NAV-per-share history with the event that caused each move.

**Underwriting** (manager view) — the deal form, re-scored on every keystroke
because the engine is pure and takes microseconds. Shows the computed metrics,
every sizing constraint with the binding one marked, the grade and decision, the
exact XLS-66 `LoanSet` fields that will be submitted, and an approve-and-originate
button. Declines render their reasons rather than a disabled button.

**Loan book** (manager view) — every loan read live from the ledger: principal and
total outstanding, periodic payment, payments remaining, days past due, impaired
and defaulted flags, and whether the loan is defaultable *yet*. Servicing actions
are `LoanPay`, impair, unimpair, and default.

Above all three, permanently: **NAV per share**, with a sparkline against a
dashed par line at 1.0, and both the deposit and redemption exchange rates. The
protocol prices those two differently and exposes neither, so both are computed
and shown side by side.

The default button stays disabled until the loan is actually defaultable, and its
tooltip says which precondition is missing. The API returns `409` with the real
reason rather than letting a raw `tecTOO_SOON` reach the screen.

### Verifying the UI

`npm run web:smoke` renders every screen to a string against **live API data** and
asserts on the content. A passing `vite build` proves the code compiles; it does
not prove a component survives contact with a real payload, and a blank page in
front of a judge is the failure mode that matters.

---

## Architecture

```
src/
├── config.ts              network, verified ledger constants
├── units.ts               THE rate conversion — 1/10 bps, one place only
├── store.ts               JSON persistence (identifiers only, never state)
├── ledger/                every XRPL call lives behind this boundary
│   ├── client.ts          connection singleton
│   ├── wallets.ts         role wallet loading
│   ├── amounts.ts         IOU / MPT / XRP amount construction
│   ├── amendments.ts      SHA-512Half amendment id derivation
│   ├── submit.ts          autofill, sign, submit, verify, log
│   ├── read.ts            vault_info, ledger_entry, validated close time
│   ├── vault.ts           VaultCreate / Deposit / Withdraw / Delete
│   ├── broker.ts          LoanBrokerSet + Cover*
│   ├── loan.ts            LoanSet (dual-sign), LoanPay, LoanManage, LoanDelete
│   └── nav.ts             NAV per share, deposit and redemption rates
├── underwriting/          pure functions, zero network calls
│   ├── policy.ts          the credit box, as data
│   ├── amortisation.ts    annuity maths, unit-tested by hand
│   ├── metrics.ts         income and loan metrics
│   ├── size.ts            constraint solving
│   ├── grade.ts           grading and the approve/decline decision
│   ├── engine.ts          the fixed-point iteration
│   └── terms.ts           -> XLS-66 LoanSet fields
├── demo/                  the three deals, policy hash
├── scripts/               runnable steps, each printing hashes
└── server/                thin HTTP layer over the above

web/                       Vite + React front end
├── src/api.ts             API client + polling hook
├── src/types.ts           the server contract, spelled out
├── src/format.ts          display formatting only
├── src/components/        NavBar (always on screen), Sparkline
├── src/screens/           Fund, Underwriting, LoanBook
└── src/smoke.tsx          renders every screen against live API data
```

**Nothing outside `src/ledger/` imports `xrpl`.** That boundary is what let the
demo runner be swapped for a UI without touching correctness-critical code — the
front end was added without editing a single file under `src/ledger/` or
`src/underwriting/`. `src/underwriting/` has no network dependency at all, which
is why it can be exhaustively unit-tested and why the UI can re-score a deal on
every keystroke.

### Transaction map

| Transaction | Where |
| --- | --- |
| `VaultCreate` | [`src/ledger/vault.ts`](src/ledger/vault.ts) `createVault` |
| `VaultDeposit` | [`src/ledger/vault.ts`](src/ledger/vault.ts) `depositToVault` |
| `VaultWithdraw` | [`src/ledger/vault.ts`](src/ledger/vault.ts) `withdrawFromVault` |
| `VaultDelete` | [`src/ledger/vault.ts`](src/ledger/vault.ts) `deleteVault` |
| `LoanBrokerSet` | [`src/ledger/broker.ts`](src/ledger/broker.ts) `createBroker` |
| `LoanBrokerCoverDeposit` | [`src/ledger/broker.ts`](src/ledger/broker.ts) `depositCover` |
| `LoanBrokerCoverWithdraw` | [`src/ledger/broker.ts`](src/ledger/broker.ts) `withdrawCover` |
| `LoanBrokerDelete` | [`src/ledger/broker.ts`](src/ledger/broker.ts) `deleteBroker` |
| `LoanSet` (dual-signed) | [`src/ledger/loan.ts`](src/ledger/loan.ts) `originateLoan` |
| `LoanPay` | [`src/ledger/loan.ts`](src/ledger/loan.ts) `payInstallment`, `repayInFull` |
| `LoanManage` (impair/unimpair/default) | [`src/ledger/loan.ts`](src/ledger/loan.ts) |
| `LoanDelete` | [`src/ledger/loan.ts`](src/ledger/loan.ts) `deleteLoan` |
| `AccountSet`, `TrustSet`, `Payment` | [`src/scripts/bootstrap-iou.ts`](src/scripts/bootstrap-iou.ts) |

There is no `LoanDraw` — it was removed from the spec. Principal moves to the
borrower on a successful `LoanSet`.

---

## What we had to verify against the live network

Full record with evidence in [`docs/verified.md`](docs/verified.md). The findings
that changed the code:

| | Finding |
| --- | --- |
| **V4** | `CoverRateMinimum`/`CoverRateLiquidation` max is 100000 = **100%**, so 10% is 10000. Getting this wrong by 10x is silent. |
| **V5** | `LoanSet` dual-signing: the **submitter signs first**, then the counterparty. The reverse order throws. `CounterpartySignature` is `isSigningField: false`, so both parties sign the same payload. |
| **V7** | A loan **cannot be defaulted without prior impairment** — you get `tecTOO_SOON` even when past due and past grace. |
| **V8** | `InterestRate` is **annualised and prorated** by `PaymentInterval / year`, over a **365.25-day** year. This determined the entire demo design. |
| **V10** | The origination fee accrues to the **broker**, not the vault. LP returns come from interest alone. |
| **V11** | First-loss absorption is capped at **required** cover, not available cover. |

---

## HTTP API

`npm run server` → `http://localhost:8787`

| | |
| --- | --- |
| `GET /api/health` | network, validated close time, whether a fund is open |
| `GET /api/fund` | NAV, both exchange rates, cover position, LP positions |
| `GET /api/loans` | every loan, read live from the ledger |
| `GET /api/policy` | the credit box and grade table |
| `GET /api/deals` | the demo deals with their underwriting |
| `GET /api/balances` | demo USD by role |
| `GET /api/transactions` | every transaction this build has submitted |
| `POST /api/underwrite` | score an arbitrary deal — pure, no writes |
| `POST /api/originate` | underwrite and originate if approved |
| `POST /api/deposit`, `/api/withdraw`, `/api/cover` | vault and cover operations |
| `POST /api/loans/:id/pay` `/impair` `/unimpair` `/default` | loan servicing |

A decline from `POST /api/originate` returns `200` with `approved: false` and the
reasons — it is a legitimate credit outcome, not a server error.

---

## Testing

```
npm test     # 66 tests, no network
```

The amortisation schedule is checked against figures computed by hand and shown in
the test comments, plus an independent forward simulation that applies interest
and subtracts the payment period by period and confirms the balance retires to
zero. When the first version of those expectations disagreed with the
implementation, the expectations were recomputed from scratch rather than adjusted
to match — the implementation turned out to be right and the test wrong.

Rate conversion is pinned at the exact values in the spec, including an explicit
test that 10% is `10000` and **not** `100000`.

---

## Known limitations

An honest list.

- **Devnet only, server-side keys.** No wallet-extension signing (no Xaman or
  GemWallet). Seeds sit in a gitignored JSON file, and every write is signed
  server-side. The UI has no wallet connection and does not need one, which also
  means it trusts the server completely.
- **The UI acts as every role.** There is no auth and no role separation — the LP
  and manager screens are tabs, not accounts. One operator, five role wallets.
- **UI verification is render-level, not browser-level.** `npm run web:smoke`
  renders every screen against live API data and asserts on content, and the
  production build is clean, but there is no automated click-through test.
- **One borrower wallet** for both loans. Realistic multi-sponsor modelling was
  out of scope.
- **The underwritten loan is interest-only; the originated loan amortises.** The
  protocol offers no balloon structure. Disclosed above and in F7.
- **`GracePeriod` is 60s rather than a real month** so a default fits in the demo.
- **No rehab draw schedule.** The advance/holdback split is modelled in
  underwriting but the full commitment funds at once on-chain.
- **No secondary trading of vault shares**, no private vaults, no Credentials or
  Permissioned Domains — all deliberately out of scope.
- **Property inputs are hand-written.** No MLS, no external data.
- **`repayOnSchedule` prepays**, so the late-payment path (`tfLoanLatePayment`,
  late interest) is implemented but not exercised by the demo. The exact-amount
  arithmetic for a late payment is a client-side reconstruction and is marked as
  best-effort in the code.

---

## Documents

- [`docs/verified.md`](docs/verified.md) — every claim checked against the live
  network, with the check, the result, and the transaction hash.
- [`docs/feedback-log.md`](docs/feedback-log.md) — developer feedback, written as
  proposals rather than complaints, plus a specific account of how AI was used and
  where it was wrong.
- [`docs/decisions.md`](docs/decisions.md) — the decisions, including the one that
  changed mid-build and why.
