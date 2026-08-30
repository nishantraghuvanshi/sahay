"""Order lifecycle and the one write that turns money into a subscription.

Kept out of routes.py because two callers need it: the HTTP surface the buyer
touches, and scripts/confirm_payment.py, which is where a human confirms they
saw the credit land. Confirmation has no HTTP route on purpose — it is the step
that grants a paid month, and there is no operator authentication in this build
to put in front of it. A shell on the box is the authentication.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

from api.payments import plans, upi

UTR_RE = re.compile(r"^\d{12}$")

# Stamped on `payments.confirmed_by` when BILLING_AUTOCONFIRM granted the month
# on the buyer's word instead of a person matching the credit. Spelled out
# rather than a flag or a blank, because the one question anyone will ask of
# this table later is "which of these did somebody actually check", and the
# answer has to be readable in the row itself.
AUTO_CONFIRMED_BY = "auto — unverified claim"


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def expire_stale(conn) -> None:
    """Release the paise suffix held by orders whose window has closed.

    Run before allocating, not on a timer: the only moment a stale reservation
    matters is when a new order needs the amount it is sitting on.
    """
    await conn.execute(
        "UPDATE payments SET status = 'expired' "
        "WHERE status = 'created' AND expires_at < $1",
        now_iso(),
    )


async def allocate_amount(conn, base_paise: int) -> int | None:
    """base + a suffix no other open order is waiting on, or None if all taken.

    Suffixes run 1..99, never 0: a payment of exactly ₹499.00 is what somebody
    pays when they ignore the amount we asked for and round it, and that is the
    one case we must not silently attribute to an order.
    """
    taken = {
        row[0]
        for row in await conn.fetch(
            "SELECT amount_paise FROM payments WHERE status = 'created' "
            "AND amount_paise BETWEEN $1 AND $2",
            base_paise + 1,
            base_paise + 99,
        )
    }
    for suffix in range(1, 100):
        if base_paise + suffix not in taken:
            return base_paise + suffix
    return None


async def create_order(conn, *, caregiver_id: str, plan: str, vpa: str,
                       payee_name: str, window_min: int) -> dict | None:
    """A row in `created` and the deep link that pays it. None if the 99 open
    slots for this plan are all spoken for."""
    base = plans.price_paise(plan)
    assert base is not None  # the route validates the plan key first

    await expire_stale(conn)
    amount = await allocate_amount(conn, base)
    if amount is None:
        return None

    ref = upi.new_ref()
    created = datetime.now(UTC)
    expires = created + timedelta(minutes=window_min)

    await conn.execute(
        "INSERT INTO payments (id, caregiver_id, plan, amount_paise, currency, "
        "provider, payee_vpa, status, expires_at, created_at) "
        "VALUES ($1,$2,$3,$4,'INR','upi',$5,'created',$6,$7)",
        ref,
        caregiver_id,
        plan,
        amount,
        vpa,
        expires.isoformat(),
        created.isoformat(),
    )

    return {
        "order_id": ref,
        "plan": plan,
        "plan_name": plans.PLANS[plan]["name"],
        "amount_paise": amount,
        "amount_display": upi.rupees(amount),
        "payee_vpa": vpa,
        "payee_name": payee_name,
        "upi_url": upi.intent_url(
            vpa=vpa, payee_name=payee_name, amount_paise=amount, ref=ref
        ),
        "expires_at": expires.isoformat(),
    }


async def claim(conn, *, caregiver_id: str, order_id: str, utr: str) -> dict:
    """The buyer says they have paid, and gives the UTR from their UPI app.

    This grants nothing. It moves the order to `claimed` so a human knows to go
    look, and it is scoped to the caregiver's own order so one signed-in user
    cannot claim another's.
    """
    utr = utr.strip()
    if not UTR_RE.match(utr):
        return {"ok": False, "error": "bad_utr"}

    row = await conn.fetchrow(
        "SELECT id, status, expires_at FROM payments WHERE id = $1 AND caregiver_id = $2",
        order_id,
        caregiver_id,
    )
    if row is None:
        return {"ok": False, "error": "order_not_found"}
    if row["status"] == "confirmed":
        # Already paid for. Not an error the buyer needs to fix.
        return {"ok": True, "status": "confirmed"}

    # An expired order whose money actually arrived is a real and recoverable
    # state: the credit is in the bank either way. Reopen it as a claim rather
    # than refusing, and let the human confirming it decide.
    existing = await conn.fetchval("SELECT id FROM payments WHERE utr = $1", utr)
    if existing is not None and existing != order_id:
        return {"ok": False, "error": "utr_already_used"}

    await conn.execute(
        "UPDATE payments SET status = 'claimed', utr = $2, claimed_at = $3 WHERE id = $1",
        order_id,
        utr,
        now_iso(),
    )
    return {"ok": True, "status": "claimed"}


async def confirm(conn, *, utr: str, by: str) -> dict:
    """A human matched the credit. This is the only thing that grants a month.

    Idempotent by UTR: re-running it on an already-confirmed payment reports the
    subscription it produced instead of extending the period a second time.
    """
    row = await conn.fetchrow(
        "SELECT id, caregiver_id, plan, amount_paise, status, confirmed_at "
        "FROM payments WHERE utr = $1",
        utr.strip(),
    )
    if row is None:
        return {"ok": False, "error": "no_such_utr"}
    if row["status"] == "confirmed":
        return {"ok": True, "already": True, "order_id": row["id"]}

    now = datetime.now(UTC)
    await conn.execute(
        "UPDATE payments SET status = 'confirmed', confirmed_at = $2, confirmed_by = $3 "
        "WHERE id = $1",
        row["id"],
        now.isoformat(),
        by,
    )

    sub = await grant(
        conn,
        caregiver_id=row["caregiver_id"],
        plan=row["plan"],
        amount_paise=row["amount_paise"],
        payment_id=row["id"],
        at=now,
    )
    return {"ok": True, "order_id": row["id"], "subscription": sub}


async def grant(conn, *, caregiver_id: str, plan: str, amount_paise: int,
                payment_id: str, at: datetime) -> dict:
    """Write or extend the caregiver's single subscription row.

    Extends from whichever is later, the existing period end or now: paying
    early should add a month to what you have, and paying after a lapse should
    not backdate the new period into the gap.
    """
    existing = await conn.fetchrow(
        "SELECT id, current_period_end FROM subscriptions WHERE caregiver_id = $1",
        caregiver_id,
    )
    now_s = at.isoformat()

    if existing is None:
        end = at + timedelta(days=plans.PERIOD_DAYS)
        await conn.execute(
            "INSERT INTO subscriptions (id, caregiver_id, plan, status, amount_paise, "
            "payment_id, current_period_start, current_period_end, created_at, updated_at) "
            "VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$6,$6)",
            f"sub_{payment_id}",
            caregiver_id,
            plan,
            amount_paise,
            payment_id,
            now_s,
            end.isoformat(),
        )
        return {"plan": plan, "status": "active", "current_period_end": end.isoformat()}

    prior_end = _parse(existing["current_period_end"])
    base = prior_end if prior_end and prior_end > at else at
    end = base + timedelta(days=plans.PERIOD_DAYS)
    await conn.execute(
        "UPDATE subscriptions SET plan = $2, status = 'active', amount_paise = $3, "
        "payment_id = $4, current_period_end = $5, updated_at = $6 WHERE id = $1",
        existing["id"],
        plan,
        amount_paise,
        payment_id,
        end.isoformat(),
        now_s,
    )
    return {"plan": plan, "status": "active", "current_period_end": end.isoformat()}


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
