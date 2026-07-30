# Decisions

The choices from §3 of the implementation plan, resolved, with what actually
happened to each once the build met the network.

| # | Decision | Taken | Notes |
| --- | --- | --- | --- |
| D1 | Team size | Solo | — |
| D2 | Language | TypeScript on Node | Node v24.14.1, xrpl.js 5.0.0 |
| D3 | Front end | Vite + React | Built after the ledger work landed. See "Scope" below. |
| D4 | Vault asset | IOU issued by our own devnet issuer | Confirmed a good call — decimal-string amounts throughout, no `AssetScale` boundary to get wrong. RLUSD-on-Devnet was not investigated; the self-issued IOU has no external dependency. |
| D5 | Persistence | JSON files under `data/` | Holds identifiers and off-chain artefacts only. Never balances or loan state — those are re-read from the ledger after every write. |
| D6 | Demo clock | **Changed during the build** | See below. This is the most consequential decision on the project. |
| D7 | Project name | Lintel | — |

---

## D6 — demo time compression, revised

**The plan's approach** (§7.4) was to compress `PaymentInterval` — represent a
month as 120 seconds and run a 12-month loan in minutes.

**Why it had to change.** We verified empirically (V8) that the ledger reads
`InterestRate` as an *annualised* rate and charges each period
`rate x PaymentInterval / year`. Interest is therefore a function of the interval
in **seconds**. Compressing a month to 120 seconds compresses the interest by the
same 22,000x factor, and it cannot be corrected by raising the rate because
`InterestRate` is capped at 100%.

Measured, not theorised: a $127,500 loan at a compressed 240-second period charged
**$0.0538** of total interest across its whole life. A vault whose NAV moves by
five cents demonstrates nothing, and the plan's own §12 requires NAV to move
observably on interest.

**What we do instead.** The terms are not compressed. `PaymentInterval` is a real
month (2,629,800s), `PaymentTotal` is the real payment count, and `InterestRate` is
the real annual rate. The same loan now charges **$6,655.77** of interest and moves
NAV per share from 1.000000 to 1.008242.

The compression is applied to the *pacing* instead: installments are prepaid
rather than waited out. This is sound because an early payment is an on-time
payment, and `PeriodicPayment` is fixed at origination — so paying early does not
reduce the interest charged. The economics survive; only the waiting is skipped.

**The one genuine deviation.** `GracePeriod` is held at its 60-second floor rather
than a real month, so an impaired loan can be defaulted inside the demo. That is a
real difference from a production loan and it is disclosed in the terms object
(`compression.graceShortened`), in the console narration, and in the README.

---

## D3 — scope and ordering: ledger first, then the interface

The build ran Phases 0, 1 and 2 to completion before any UI work started, which
is the ordering the plan mandates (§5: "No UI work begins before this gate
passes").

That ordering paid for itself. Three findings from the live network — V5 (signing
order), V7 (impairment precedes default), V8 (annualised interest) — would each
have invalidated a UI built against assumed behaviour. V8 in particular changed
the meaning of every loan on screen, and the loan-book screen's disclosure text
would have been actively false had it been written first.

Everything now exists:

- `npm run demo` — the full narrated lifecycle, console-rendered.
- `npm run server` — the HTTP API, which is the boundary the UI consumes.
- `npm run web` — three screens: Fund, Underwriting, Loan book.

The `src/ledger/` boundary held. The front end was added **without editing a
single file** under `src/ledger/` or `src/underwriting/` — the only backend change
the UI required was none at all, because the API had already been built against
the same contract.

**No UI framework beyond React.** No component library, no chart library, no CSS
framework. The sparkline is 30 lines of hand-rolled SVG; pulling in a charting
dependency to draw one polyline over a dozen points would have been more code and
more supply chain for no gain.

### UI verification

`npm run web:smoke` renders every screen to a string against **live API data** and
asserts on the content, including the empty state. A passing `vite build` proves
the code compiles; it does not prove a component survives a real payload, and a
blank page in front of a judge is the failure that matters. All five render paths
pass.

Every write path the UI exposes was also exercised end to end against Devnet:
deposit, withdraw, originate (dual-signed `LoanSet` through the API), pay, impair,
unimpair, and a default correctly refused with `409` and the real reason rather
than a raw `tecTOO_SOON`.

---

## Underwriting: interest-only, not amortising

Not in the plan's decision list, but it is a modelling decision worth recording.

Bridge loans are interest-only with the principal retired at exit. Underwriting
DSCR against a fully-amortising 12-month schedule would charge the property with
repaying its entire principal out of one year of net operating income — which
caps every loan at roughly one year of NOI and makes DSCR bind on every deal for a
reason that has nothing to do with credit.

So the engine underwrites interest-only. The loan XLS-66 originates, however,
amortises over `PaymentTotal` payments — the protocol has no interest-only or
balloon structure. That gap is disclosed in the README and is entry F7 in the
feedback log, because interest-only is the dominant structure in the asset class
the protocol suits best.
