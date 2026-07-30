# Developer feedback log

Kept live during the build. Every entry is something that actually cost time or
surprised us on this build, converted into a proposal rather than left as a
complaint. Each one names the evidence in `docs/verified.md` that produced it.

---

## F1 — `InterestRate` units and basis are undiscoverable from the field name

**What happened.** We submitted `InterestRate: 1583` intending 1.583% per payment
period, on a $127,500 loan with `PaymentInterval: 240` and `PaymentTotal: 6`. The
transaction succeeded. The ledger computed `PeriodicPayment = 21250.00896`, i.e.
**five cents of total interest** on a $127,500 loan.

The rate is not per-period. It is annualised and prorated by
`PaymentInterval / year`, over a 365.25-day year. Neither of those facts is
recoverable from the field name, the type, or the client-side validator — and
none of them fails loudly. A loan wrong by a factor of 131,000 returns
`tesSUCCESS`. (See V8, V8a.)

**Why it matters.** Every other amount field on `LoanSet` is denominated in the
asset. `InterestRate` is denominated in 1/10 basis points *per annum*, prorated by
a time field elsewhere in the same transaction. Three separate conventions have to
be known simultaneously and none is stated at the point of use.

**Proposals**, in order of preference:

1. Name the field for its units and basis: `InterestRateAnnualTenthBps`. Long, but
   a client cannot then be silently wrong.
2. Return the computed `PeriodicPayment` in the `LoanSet` transaction metadata, so
   a client can assert against it in the same round trip instead of issuing a
   follow-up `ledger_entry` and reverse-engineering the convention. We had to
   write that probe (`src/scripts/lifecycle.ts`) to learn any of this.
3. Publish the day-count convention. 365.25 days is a defensible choice, but we
   determined it by solving the observed `PeriodicPayment` for the implied year
   length and comparing against 360/365/365.25/366. That should not be necessary.
4. Reject, or at minimum warn on, loan terms whose total interest rounds to
   effectively zero relative to principal. `tecKILLED` already exists for
   degenerate terms; a schedule producing 0.00004% total interest is degenerate in
   the same practical sense.

---

## F2 — the 100% rate ceiling and the 60-second interval floor make short-cycle testing impossible

**What happened.** Following the conventional advice for demoing a long-dated
instrument, we compressed a month to 120 seconds. Because interest is prorated by
the interval *in seconds* (F1), that compressed the interest by the same 22,000x
factor. It cannot be corrected by raising the rate, because `InterestRate` is
capped at 100000 tenth-bps = 100%.

**The arithmetic that closes off the approach.** The maximum interest expressible
in one payment period is `100% x PaymentInterval / 31,557,600`. At the 60-second
floor that is **0.00019% of principal**. To charge one month of interest at a
realistic 9.5% you need an interval of roughly 5.8 days.

So a compressed-time demo of a lending protocol cannot show interest accruing at
all — the one thing a lending protocol does.

**What we did instead.** Kept `PaymentInterval` at a real month and compressed
only the *pacing*, by prepaying installments. Prepayment is accepted, an early
payment is an on-time payment, and `PeriodicPayment` is fixed at origination, so
the economics survive. This works, but it is a workaround we found by accident
after the direct approach silently produced a fund whose NAV moved by $0.05.

**Proposals:**

1. Decouple the rate from wall-clock proration — e.g. a `tfInterestPerPeriod` flag
   on `LoanSet` that makes `InterestRate` apply once per period regardless of
   interval length. Testing a 12-period loan would then take 12 minutes rather
   than 12 months, with correct economics.
2. Alternatively, allow `InterestRate` above 100% when `PaymentInterval` is below
   some threshold. Less clean, but it preserves the current model.
3. Document the prepayment workaround prominently in the lending tutorials. It is
   the only way we found to demo the protocol honestly, and we found it ourselves.

---

## F3 — a loan cannot be defaulted without being impaired first, and `tecTOO_SOON` does not say so

**What happened.** We called `LoanManage` with `tfLoanDefault` on a loan already
**80 seconds past** `NextPaymentDueDate + GracePeriod`. Result: `tecTOO_SOON`.

The loan must carry `lsfLoanImpaired` first, and a grace period must elapse *from
the impairment*. That is a sensible design — impairment is the on-ledger notice
that starts the clock — but `tecTOO_SOON` describes a timing problem, and we had
already satisfied every timing condition we could see. We spent time re-checking
ledger close times before questioning the state machine. (See V7.)

**Proposals:**

1. Return a distinct code — `tecNOT_IMPAIRED` or `tecPRECONDITION` — when the
   loan is not impaired. `tecTOO_SOON` is actively misleading here because the
   timing genuinely *was* satisfied.
2. Document the loan state machine as a diagram: active → impaired → defaulted,
   with the transition preconditions on each edge. The transaction reference
   documents the flags individually; the ordering constraint between them is the
   part that costs time.
3. `tecTOO_SOON` is absent from the error tables in the lending documentation.

---

## F4 — `LoanSet` counterparty signing order is the reverse of the intuitive one, and the reason is invisible

**What happened.** The natural reading — counterparty signs, then the submitter
signs the completed transaction including `CounterpartySignature` — is wrong.
`signLoanSetByCounterparty` throws `"Transaction must be first signed by first
party"`.

The actual order is: `Account` signs, *then* the counterparty signs, then the blob
is submitted unmodified. This is correct and it makes sense once you know that
`CounterpartySignature` is declared `isSigningField: false` in the binary codec,
so it is excluded from `encodeForSigning` and both parties sign the identical
payload. But that fact lives in `definitions.json`, not in any documentation a
developer would read while writing signing code. (See V5.)

**Proposals:**

1. State the ordering in the `LoanSet` reference, with the one-line reason:
   "`CounterpartySignature` is not a signing field, so both parties sign the same
   payload; the submitter must sign first."
2. Provide a single `signLoanSetBoth(accountWallet, counterpartyWallet, tx)` helper
   in xrpl.js. The two-step dance has exactly one correct order and no reason to
   be assembled by hand at every call site.
3. The advisory printed during autofill — *"For LoanSet transaction the auto
   calculated Fee accounts for total number of signers…"* — arrives on stdout with
   no indication of severity. It reads like a warning. It is not.

---

## F5 — payment amounts require more precision than the asset can express

**What happened.** `PeriodicPayment` came back as `11180.03304066033228`. We
computed the installment as `PeriodicPayment + LoanServiceFee`, rounded to cents
as any currency-handling code would, and submitted `11307.53`. Result:
`tecINSUFFICIENT_PAYMENT` — we were **0.003 short**.

The fix is to round *up*, always. But the mirror case exists too:
`LoanBrokerCoverWithdraw` for the full `CoverAvailable` of `69182.7760210308`
fails with `tecINSUFFICIENT_FUNDS` if you round to nearest, because 69182.78 is
more than exists. So paying rounds up and withdrawing rounds down, and getting
either backwards produces a `tec` code that names the symptom rather than the
rounding.

**Proposals:**

1. Expose the exact amount due as a queryable field — `AmountDue` on the `Loan`
   entry, or a `loan_payment_quote` method. Every client will otherwise
   reimplement this rounding rule, and half will get it wrong in one direction.
2. Accept a payment within a defined epsilon of the required amount, crediting
   only what is owed. A third of a cent is not a real underpayment.
3. Document the round-up/round-down asymmetry in the lending tutorials.

---

## F6 — NAV per share is not queryable, and neither exchange rate is

**What happened.** The single most important number for a vault depositor —
NAV per share — has to be reconstructed client-side as
`(AssetsTotal − LossUnrealized) / shareSupply`, where the share supply comes from
a *different* object (the share MPT issuance) than the assets.

The protocol's two-rate model is genuinely well designed: deposits are priced so a
new depositor does not buy into a loss they were not present for, redemptions are
priced on current value. But neither rate is directly queryable, so a client
cannot ask what a share currently costs or what it is currently worth. Both had
to be derived. (See `src/ledger/nav.ts`.)

**Proposals:**

1. Add `SharesOutstanding`, `DepositRate`, and `RedemptionRate` to the
   `vault_info` response. All three are already computed inside the ledger to
   process a deposit; exposing them costs nothing and removes an entire class of
   client-side reconstruction bugs.
2. Failing that, at least return the share supply in `vault_info` so it does not
   require a second lookup against the MPT issuance.

---

## F7 — impairment and default have significant, undocumented accounting semantics

**What happened.** Three behaviours we discovered only by measuring balances before
and after each transaction (see V10, V11, and the NAV series in the demo):

1. **Origination books the full expected interest immediately.** Writing a
   $478,149 loan raised `AssetsTotal` by $30,023 — the loan's entire projected
   interest, recognised as a receivable at origination rather than accrued over
   the term. NAV per share jumps on origination.
2. **Impairment writes the whole loan down.** `LossUnrealized` went from 0 to the
   full $508,172 outstanding, not to an expected-loss estimate. NAV fell from
   1.045771 to 0.410556 on a *watchlist* action.
3. **Default reimburses from cover, so NAV partially recovers.** Cover absorbed
   $50,817 and NAV rose from 0.410556 to 0.474078 — a loan defaulting made NAV go
   *up*, because the impairment provision had assumed a total loss.

Each of these is defensible. Together they mean NAV per share moves in ways a fund
operator would need to explain to their LPs, and none of it is documented.

Also: first-loss absorption is capped at the **required** cover
(`CoverRateMinimum` x debt), not at cover **available**. Our broker held $120,000;
only $50,817 could be drawn against a $508,172 default. A manager who over-posts
cover expecting deeper protection does not get it.

**Proposals:**

1. Document the accounting lifecycle explicitly: what origination, impairment,
   payment, and default each do to `AssetsTotal`, `AssetsAvailable`, and
   `LossUnrealized`. A single table would do it.
2. Reconsider whether impairment should write down the full outstanding balance or
   accept a manager-supplied provision amount. Full write-down makes impairment a
   very blunt instrument — ours moved NAV by 61% for a loan that had not yet
   missed a payment.
3. Make explicit that `CoverRateLiquidation` is a fraction of *required* cover, not
   of available cover. We read the field name as the latter.

---

## F8 — `ManagementFeeRate`, `CoverRateMinimum` and `CoverRateLiquidation` are immutable

A fund's management fee and subordination level are commercial terms that get
renegotiated. Here they are fixed at `LoanBrokerSet` and cannot be changed, so the
only way to reprice is to stand up a new `LoanBroker` and migrate the book.

We do not think this is wrong — immutability protects LPs from a manager quietly
raising its own fee, which is a real risk this design eliminates. But it should be
called out prominently as a **deliberate** constraint, because it is currently
discoverable only by trying to change one.

**Proposal:** state it in the `LoanBrokerSet` reference, with the LP-protection
rationale. If mutability is ever added, gate it behind notice to shareholders
rather than allowing it outright.

---

## F9 — smaller things

- **`VaultWithdrawalPolicy` has exactly one value.** `vaultStrategyFirstComeFirstServe`
  = 1 is the only member. A UINT8 enum encoding no choice is fine as
  forward-compatibility, but the field reads as a decision a developer has to make
  and it is not one. Documenting "currently one strategy; the field exists for
  future policies" would save the consideration. (V3)
- **Inconsistent `Data` limits and units.** `VaultCreate.Data` is capped at 256
  **bytes**; `LoanSet.Data` and `LoanBrokerSet.Data` at 512 **hex characters**
  (= 256 bytes). Same effective size, expressed two different ways, validated by
  two differently-written checks in the same library. Pick one unit. (V13)
- **`LoanScale: -10` appears on every `Loan` entry** while all amount fields are
  plain decimal strings needing no rescaling. We wrote a probe to confirm the field
  could be ignored. Either document it or omit it. (V12)
- **Amendments enabled in a network's genesis ledger are absent from the
  `Amendments` ledger entry.** Devnet reports 87 enabled amendments and
  `MultiSign` is not among them, despite being active. Any tool that checks
  amendment status by reading that entry will report false negatives on exactly
  the amendments that have been enabled longest. We nearly shipped a broken GATE 0
  check because of this. Proposal: document the caveat next to the `Amendments`
  ledger entry reference.
- **The origination fee accrues to the broker owner, not the vault.** Correct — it
  is the manager's fee — but it means LP returns come from interest alone, which
  interacts badly with F2. Worth stating in the fee documentation. (V10)

---

## How AI was used on this build

Specifically, and including where it was wrong.

**Where it helped.**

- *Spec comprehension.* The XLS-65/66 specs, the xrpl.js validators, and the
  binary codec definitions were read and cross-referenced far faster than by hand.
  The `isSigningField: false` finding behind F4 came out of that.
- *Designing the empirical probes.* The decisive move on this build was not
  reading harder, it was deciding to **measure**: originate a loan with known
  terms, read `PeriodicPayment` back, and test hypotheses against it. That probe
  (`src/scripts/lifecycle.ts`) produced F1, F2, and the 365.25-day finding, none of
  which we would have got from documentation.
- *Test-case generation.* The amortisation suite is checked against schedules
  computed independently, including a forward simulation that applies interest and
  subtracts the payment period by period to confirm the balance retires to zero.
- *Underwriting narrative.* The metric definitions, the grade table, and the
  decline reasoning were drafted quickly and then corrected against real bridge
  lending practice.

**Where it was wrong, and had to be caught.**

- The initial amortisation test expectations were computed carelessly and were
  wrong by $16 and $0.32. The implementation was correct; the *test* was wrong.
  Caught because the failure was recomputed from scratch rather than adjusting the
  expected value to match — which is the tempting move and would have locked in a
  wrong test.
- The first underwriting model used a fully-amortising debt service for DSCR.
  That is wrong for bridge lending — it charges the property with repaying all its
  principal from one year of NOI — and it made DSCR bind on every deal for a
  reason having nothing to do with credit. Rewritten as interest-only.
- `POLICY.maxLtvAsIs` was defined and never used, leaving a 98% as-is LTV
  unremarked. Fixed by modelling the rehab holdback properly: as-is LTV is
  measured against the advance at close, not the full commitment.
- The first decline path was structurally dead code. Sizing satisfies every ratio
  floor *by shrinking the loan*, so re-testing those floors after sizing can never
  fail. The only real decline test is proceeds adequacy — which sizing cannot
  satisfy, because shrinking the loan is what breaks it.
- Several plan-level assumptions that turned out to be wrong against the live
  network are recorded in `docs/verified.md` rather than quietly corrected: the
  10x error in the suggested cover rates (V4), the signing order (V5), and the
  interest-rate basis (V8).
