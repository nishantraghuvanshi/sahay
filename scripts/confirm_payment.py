#!/usr/bin/env python3
"""Confirm a UPI payment by hand, and grant the month it bought. FR-30.

This is the deliberate human step in a flow with no payment gateway. The bank
sends the server no callback, so nothing but a person looking at the credit in
their UPI app can say a payment is real — and because confirming grants a paid
subscription, it is a shell command rather than an HTTP route. There is no
operator authentication in this build to put in front of one.

    # what is waiting to be checked
    python scripts/confirm_payment.py --list

    # confirm the credit you can see, by its UTR
    python scripts/confirm_payment.py 123456789012 --by soumya

Match on the AMOUNT first. Every open order holds a unique paise suffix, so the
credit in your statement identifies exactly one order with no guessing; the UTR
is corroboration and the idempotency key, not the primary match. If the amount
in your UPI app does not equal the amount on the claimed order, do not confirm
it — that is the case the scheme exists to catch.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import db  # noqa: E402
from api.payments import service, upi  # noqa: E402


async def show_pending() -> int:
    async with db.connection() as conn:
        rows = await conn.fetch(
            "SELECT p.id, p.plan, p.amount_paise, p.status, p.utr, p.claimed_at, "
            "       c.name, c.phone_e164 "
            "FROM payments p JOIN caregivers c ON c.id = p.caregiver_id "
            "WHERE p.status IN ('created','claimed') "
            "ORDER BY p.created_at DESC",
        )

    if not rows:
        print("Nothing awaiting confirmation.")
        return 0

    print(f"{'ORDER':<10} {'AMOUNT':>10}  {'STATUS':<8} {'UTR':<14} WHO")
    for r in rows:
        who = f"{r['name'] or '—'} · {r['phone_e164']}"
        print(
            f"{r['id']:<10} {'₹' + upi.rupees(r['amount_paise']):>10}  "
            f"{r['status']:<8} {r['utr'] or '—':<14} {who}"
        )
    print(
        "\nConfirm only a claimed row whose amount matches the credit in your "
        "UPI app, to the paise."
    )
    return 0


async def do_confirm(utr: str, by: str) -> int:
    async with db.transaction() as conn:
        result = await service.confirm(conn, utr=utr, by=by)

    if not result.get("ok"):
        print(f"Refused: {result['error']}", file=sys.stderr)
        return 1
    if result.get("already"):
        print(f"{result['order_id']} was already confirmed. Nothing changed.")
        return 0

    sub = result["subscription"]
    print(f"Confirmed {result['order_id']}.")
    print(f"  plan   {sub['plan']}")
    print(f"  status {sub['status']}")
    print(f"  until  {sub['current_period_end']}")
    print("\nIt is visible now on /settings in the app.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("utr", nargs="?", help="the 12-digit UPI reference to confirm")
    ap.add_argument("--list", action="store_true", help="show orders awaiting confirmation")
    ap.add_argument("--by", default="", help="who checked the credit — recorded on the row")
    args = ap.parse_args()

    db.init()

    if args.list or not args.utr:
        return asyncio.run(show_pending())
    if not args.by:
        # Recorded as evidence of who looked, not as an audit control. An empty
        # one makes the row say a payment was confirmed by nobody.
        print("--by is required: name whoever checked the credit.", file=sys.stderr)
        return 2
    return asyncio.run(do_confirm(args.utr, args.by))


if __name__ == "__main__":
    raise SystemExit(main())
