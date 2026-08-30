# Payment evidence — FR-29, FR-30

One real payment, taken through the app on 30 Aug 2026.

## The transaction

| | |
|---|---|
| Order | `KVX-UFUS` |
| Amount | **₹2.02** |
| UTR | `130915384958` |
| Method | UPI, direct to the payee VPA |
| Claimed | 2026-08-30T07:39:39.384509+00:00 |
| Confirmed | 2026-08-30T07:41:55.353151+00:00 by `soumya` |

Subscription written by that payment (`subscriptions` row, FR-30):

| | |
|---|---|
| Plan | care |
| Status | active |
| Period | 2026-08-30T07:41:55.353151+00:00 → 2026-09-29 07:41:55 |
| Payment | `KVX-UFUS` |

The amount is not the list price. Every open order is issued a unique paise
suffix so an incoming bank credit maps to exactly one order — ₹2 was the test
price, and `.02` is what identified this order among the others open at the time.

## Why the amount was ₹2 and not ₹499

Taking ₹499 to prove the pipe works costs ₹499. The suffix scheme, the claim, the
confirmation and the subscription write are identical at either price; only
`api/payments/plans.py` differed, and it was reverted to `49_900` immediately
after. Nothing about this transaction is a mock: real UPI, real bank, real money.

## Why there is no gateway

Razorpay and Cashfree both gate live mode behind merchant KYC — 1–2 working days
at best. Code freeze was the same day. So money arrives as an ordinary UPI
transfer and the bank tells the server nothing; a person matches the credit and
runs `scripts/confirm_payment.py`. See `docs/DECISIONS.md`, 30 Aug 12:20.

`payments.confirmed_by` records who checked. A row confirmed by a name was
matched against a bank statement by that person. A row reading
`auto — unverified claim` was granted by the `BILLING_AUTOCONFIRM` demo switch on
the buyer's word alone, with nothing checked — the two must never be read as the
same kind of evidence.

## Still to add

- [ ] Screenshot of the ₹2.02 credit in the receiving UPI app, showing UTR `130915384958`
- [ ] Screenshot of the checkout screen reading "Care is active"
- [ ] Screenshot of the plan card on /settings

