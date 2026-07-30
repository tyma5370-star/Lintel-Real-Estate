# Verification record

Every claim this build depends on that could not be confirmed from a primary
source, with the check that was run and the result. Written as it was learned.

**Environment for all checks below**

| | |
| --- | --- |
| Date | 29 July 2026 |
| Network | Devnet, `wss://s.devnet.rippletest.net:51233/` |
| `rippled` | 3.3.0-rc5 |
| xrpl.js | 5.0.0 |
| Node | v24.14.1 |

---

## V1 — xrpl.js exposes the vault and lending primitives

**Check:** `node -e "console.log(Object.keys(require('xrpl')).filter(k=>/Vault|Loan/i.test(k)))"`

**Result:** `LoanSetFlags`, `LoanManageFlags`, `LoanPayFlags`, `VaultCreateFlags`,
`VaultWithdrawalPolicy`, `signLoanSetByCounterparty`,
`combineLoanSetCounterpartySigners`.

xrpl.js 5.0.0 supports both amendments. No upgrade needed.

---

## V2 — GATE 0: both amendments are enabled on Devnet

**Check:** `npm run check:amendments`

Amendment ids are derived as SHA-512Half of the amendment name rather than copied
from a documentation page. The derivation is proved before it is trusted:
`SHA-512Half("MultiSign")` reproduces that amendment's published id
`4C97EBA9…DC8373` exactly.

**Result — both ENABLED:**

| Amendment | ID |
| --- | --- |
| `SingleAssetVault` | `81BD2619B6B3C8625AC5D0BC01DE17F06C3F0AB95C7C87C93715B87A4FD240D8` |
| `LendingProtocol` | `565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509` |

**Caveat worth recording:** Devnet reports 87 enabled amendments and `MultiSign`
is *not* among them, despite being active. A network whose genesis ledger already
had an amendment enabled can omit it from the `Amendments` ledger entry. So
absence from that list is suggestive, not conclusive; the conclusive test is
functional. `npm run check:amendments` says this explicitly rather than reporting
a false negative.

---

## V3 — `VaultWithdrawalPolicy` has exactly one strategy

**Check:** `node -e "console.log(require('xrpl').VaultWithdrawalPolicy)"`

**Result:** `{ vaultStrategyFirstComeFirstServe: 1 }`. One strategy only. The
field is a UINT8 enum with a single legal value, so it currently encodes no
choice. → feedback log.

---

## V4 — Rate field ceilings, from the installed validators

**Check:** read `node_modules/xrpl/dist/npm/models/transactions/loanSet.js` and
`loanBrokerSet.js`.

| Field | Maximum | As a percent |
| --- | --- | --- |
| `InterestRate`, `LateInterestRate`, `CloseInterestRate`, `OverpaymentInterestRate`, `OverpaymentFee` | 100000 | 100% |
| `CoverRateMinimum`, `CoverRateLiquidation` | 100000 | 100% |
| `ManagementFeeRate` | 10000 | **10%** |

**This corrects a 10x error in the plan.** §5.3 suggested "`CoverRateMinimum`
10%, meaning 100000 in 1/10 bps" — but 100000 is 100%, and 10% is 10000. It also
suggested `CoverRateLiquidation` 1000000 for 100%, which is ten times the maximum
the validator accepts and would be rejected outright. Both values are set
correctly in `src/ledger/broker.ts`.

**Cover-rate relationship:** the validator enforces that `CoverRateMinimum` and
`CoverRateLiquidation` are **both zero or both non-zero**, and nothing else. It
does *not* constrain their relative magnitudes, so a liquidation rate above the
minimum is accepted. We check that ourselves.

---

## V5 — `LoanSet` dual-signing order is the reverse of the obvious one

**Check:** read `node_modules/xrpl/dist/npm/Wallet/counterpartySigner.js`, and the
field definitions in `ripple-binary-codec`.

`signLoanSetByCounterparty` throws `"Transaction must be first signed by first
party"` unless `TxnSignature` is already present. So the order is:

1. `Account` (borrower) autofills and signs.
2. `Counterparty` (broker owner) calls `signLoanSetByCounterparty`.
3. The returned blob is submitted **as-is** and must not be re-signed.

**Why this works:** `CounterpartySignature` is declared `isSigningField: false` in
the binary codec, so it is excluded from `encodeForSigning`. Both parties sign the
identical canonical payload and neither signature covers the other. Re-signing at
step 3 would discard the counterparty signature.

The plan's §5.5 has the counterparty signing *first* and the submitter signing a
payload that *includes* `CounterpartySignature`. Neither is what the library does.

**Confirmed working on Devnet:** `LoanSet` returned `tesSUCCESS`, tx
`F0A47B988CA9BCD2F0CFC7429053F337215FD85B5264910EBCC52CE6480D4867`.

Note: xrpl.js prints an advisory during autofill — *"For LoanSet transaction the
auto calculated Fee accounts for total number of signers the counterparty has to
avoid transaction failure."*

---

## V6 — `LoanManage` flag values

**Check:** `node -e "console.log(require('xrpl').LoanManageFlags)"`

| Flag | Value |
| --- | --- |
| `tfLoanDefault` | `0x010000` (65536) |
| `tfLoanImpair` | `0x020000` (131072) |
| `tfLoanUnimpair` | `0x040000` (262144) |

`LoanPayFlags` are `tfLoanOverpayment` `0x010000`, `tfLoanFullPayment` `0x020000`,
`tfLoanLatePayment` `0x040000` — these match the plan.

---

## V7 — **A loan cannot be defaulted without being impaired first**

**Check:** attempted `LoanManage tfLoanDefault` on an active loan that was already
80 seconds past `NextPaymentDueDate + GracePeriod`.

**Result:** `tecTOO_SOON` — tx
`D12F6C5B572ADC1CA6013F52CC6474E5017E24D138B55280F139FC42DDD65E32`.

Being past due and past grace is **not** sufficient. The loan must carry
`lsfLoanImpaired` first, and one grace period must then elapse *from the
impairment*. Impairment is what pulls `NextPaymentDueDate` forward to now, which
is what starts that clock.

The working sequence, used in both `lifecycle.ts` and `teardown.ts`:

```
LoanManage(tfLoanImpair) -> wait GracePeriod -> LoanManage(tfLoanDefault) -> LoanDelete
```

`tecTOO_SOON` does not appear in the plan's error table (Appendix D). → feedback log.

---

## V8 — **`InterestRate` is annualised and prorated by `PaymentInterval`**

The single most consequential finding in this build.

**Check:** originate a loan with known terms and read `PeriodicPayment` back off
the `Loan` ledger entry.

| Submitted | Value |
| --- | --- |
| `PrincipalRequested` | 127500 |
| `InterestRate` | 1583 (1.583%) |
| `PaymentTotal` | 6 |
| `PaymentInterval` | 240s |

**Ledger returned:** `PeriodicPayment = 21250.00896007399224`,
`TotalValueOutstanding = 127500.053760444`.

Total interest over the loan's life: **$0.0538** on a $127,500 loan.

| Hypothesis | Predicted `PeriodicPayment` | Error |
| --- | --- | --- |
| Rate applies per period | 22,443.02 | ~1,193 |
| Rate is annualised, prorated by `interval / year` | 21,250.0090 | ~9e-6 |

Conclusive: the rate is **annualised**, and each period is charged
`rate x PaymentInterval / year`.

### V8a — the year is 365.25 days

Solving the observed `PeriodicPayment` for the implied year length gives
**365.244 days**. That is the Julian year, 365.25 days = **31,557,600 seconds**.
Reproducing the ledger's figure with it lands within 9e-6 of a dollar. Neither a
360-day nor a 365-day year fits.

### V8b — the consequence, and why the demo does not compress terms

Because interest is a function of the interval in *seconds*, compressing a month
to 120 seconds compresses the interest by the same factor — roughly 22,000x. It
cannot be corrected by raising the rate, because `InterestRate` is capped at 100%
(V4). **The most interest expressible in a 60-second period is
100% x 60/31,557,600 = 0.00019% of principal.**

A vault whose NAV moves by five cents demonstrates nothing. So this build
originates loans with **real** `PaymentInterval` (one real month, 2,629,800s),
**real** `PaymentTotal`, and the **real** annual rate. The demo compresses only
the *pacing*: installments are prepaid rather than waited out, which does not
change the interest because `PeriodicPayment` is fixed at origination.

`GracePeriod` is the one field held at its 60-second floor rather than a real
value, so an impaired loan can be defaulted inside the demo. Disclosed in the UI,
the README, and the terms object itself.

→ feedback log, with a proposal.

---

## V9 — the initial share mint is exactly `assets x 10^Scale`

**Check:** `VaultCreate` with `Scale: 6`, then deposits of 600,000 and 200,000.

**Result:** `AssetsTotal = 800000`, shares outstanding = `800000000000`.
Exactly `800000 x 10^6`. NAV per share 1.000000. No discrepancy.

`Scale` is settable on `VaultCreate` for IOU assets (0–18) and must be **omitted**
for XRP and MPT assets — the validator rejects it otherwise.

---

## V10 — the origination fee accrues to the broker, not the vault

**Check:** balances before and after a `LoanSet` of 127,500 with a 2,550
origination fee.

| | Before | After |
| --- | --- | --- |
| Borrower USD | 50,000 | 174,950 (+124,950 = principal − fee) |
| Broker USD | 80,000 | 82,550 (+2,550) |
| Vault `AssetsTotal` | 800,000.00 | 800,000.05 |
| Vault `AssetsAvailable` | 800,000.00 | 672,500.00 (−127,500) |

The vault funds the full principal but the origination fee goes to the **broker
owner**. LP NAV is therefore driven by loan *interest* only — which is exactly why
V8b matters. If terms were compressed, LP NAV would never move at all.

---

## V11 — how a default splits between first-loss capital and LPs

**Check:** default a 127,500 loan against a broker with `CoverRateMinimum` 10%
(10000) and `CoverRateLiquidation` 100% (100000), holding 120,000 of cover.

| | Before | After |
| --- | --- | --- |
| Broker `CoverAvailable` | 120,000.00 | 107,249.99 |
| Vault `AssetsTotal` | 800,000.05 | 685,250.01 |
| Vault `LossUnrealized` | 0 | 0 |
| NAV per share | 1.000000 | **0.856563** |

- First-loss capital absorbed **12,750.01** — exactly `CoverRateMinimum` (10%) of
  the outstanding debt, being 100% of the *required* cover as
  `CoverRateLiquidation` permits.
- The vault absorbed the remaining **114,750.04**.
- The loss is **realized immediately**: it reduces `AssetsTotal` directly rather
  than accumulating in `LossUnrealized`, which stayed at zero throughout.

So `LossUnrealized` is not where a completed default lands. NAV per share must be
computed as `(AssetsTotal − LossUnrealized) / shares` to be correct in both
states, which is what `src/ledger/nav.ts` does.

Cover absorption is capped at the *required* cover, not at cover *available* —
the broker held 120,000 but only 12,750.01 was drawn.

---

## V12 — `LoanScale` is present but amounts are not scaled

**Check:** raw `Loan` ledger entry after origination.

`LoanScale: -10` appears on the entry, but every amount field is a plain decimal
string in the asset's own units (`PrincipalOutstanding: 127500`,
`PeriodicPayment: 21250.00896…`). No client-side rescaling is required. Surfaced
in `getLoan` so the assumption is visible rather than implicit.

---

## V13 — `VaultCreate.Data` limit is 256 bytes; `LoanSet.Data` is 512

**Check:** `VAULT_DATA_MAX_BYTE_LENGTH` in
`node_modules/xrpl/dist/npm/models/transactions/common.js`, and `MAX_DATA_LENGTH`
in `loanSet.js` / `loanBrokerSet.js`.

- `VaultCreate.Data` — 256 **bytes**.
- `LoanSet.Data`, `LoanBrokerSet.Data` — 512 **hex characters**.

The units differ between the two checks in the library itself: one measures bytes
after halving the hex length, the other measures the hex string length. → feedback
log.

---

## Still open

- **§2.1 fresh-code question.** Not resolvable from a terminal — must be asked at
  the College Row booth. Until answered, this repo operates under reading (2):
  the reference app was not consulted for code, and every line here was written
  from the specs and the installed library's own source. No file originates from
  any prior repository.
- **RLUSD on Devnet** (Appendix C). Not checked; the build uses a self-issued IOU,
  which is sufficient and has no external dependency.
