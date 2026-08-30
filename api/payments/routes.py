"""spec: FR-28 · FR-29 · FR-30 — taking money, and what it buys.

Mounted under `/app/billing` so it shares the session-scoped `/app` surface the
rest of the caregiver app uses (and the Vite dev proxy that already forwards it).
Every route here is `CaregiverDep`: a payment belongs to the signed-in caregiver
and to nobody else.

There is no gateway behind this. See api/schema.sql `payments` for why, and
api/payments/service.py for the one operation that is deliberately NOT an HTTP
route — confirmation, which grants a paid month and lives in
scripts/confirm_payment.py because this build has no operator authentication to
put in front of it.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from api import db
from api.auth.deps import CaregiverDep, SettingsDep
from api.payments import plans, service, upi

log = logging.getLogger("kinvox.payments")

router = APIRouter(prefix="/app/billing", tags=["billing"])


def _order_json(row) -> dict:
    plan = plans.PLANS.get(row["plan"], {})
    return {
        "order_id": row["id"],
        "plan": row["plan"],
        "plan_name": plan.get("name", row["plan"]),
        "amount_paise": row["amount_paise"],
        "amount_display": upi.rupees(row["amount_paise"]),
        "status": row["status"],
        "utr": row["utr"],
        "expires_at": row["expires_at"],
        "confirmed_at": row["confirmed_at"],
    }


@router.get("/plans")
async def list_plans(settings: SettingsDep):
    """What is on sale, and whether this deployment can actually take money.

    `configured` is reported rather than hidden: the checkout screen has to be
    able to say "payments are not switched on here" instead of failing on the
    button press.
    """
    return {
        "ok": True,
        "configured": settings.billing_configured,
        "plans": list(plans.PLANS.values()),
    }


class CheckoutBody(BaseModel):
    plan: str


@router.post("/checkout")
async def checkout(body: CheckoutBody, caregiver: CaregiverDep, settings: SettingsDep):
    """Issue an order and the UPI link that pays it.

    The amount comes from api/payments/plans.py and never from the request. A
    client-supplied amount is a free subscription for anyone who opens devtools,
    which is why the body carries a plan *key* alone.
    """
    if not settings.billing_configured:
        return {"ok": False, "error": "billing_unconfigured"}
    if body.plan not in plans.PLANS:
        return {"ok": False, "error": "unknown_plan"}

    async with db.transaction() as conn:
        order = await service.create_order(
            conn,
            caregiver_id=caregiver.id,
            plan=body.plan,
            vpa=settings.upi_payee_vpa.strip(),
            payee_name=settings.upi_payee_name.strip() or "Kinvox",
            window_min=settings.payment_window_min,
        )

    if order is None:
        # All 99 paise suffixes for this plan are held by unexpired orders.
        # Refused rather than reused: two open orders waiting on the same amount
        # would make the credit that arrives unattributable, and guessing which
        # caregiver paid is exactly the failure this scheme exists to prevent.
        log.warning("checkout refused: no free amount slot for plan %s", body.plan)
        return {"ok": False, "error": "checkout_busy"}

    return {"ok": True, "order": order}


class ClaimBody(BaseModel):
    order_id: str
    utr: str


@router.post("/claim")
async def claim(body: ClaimBody, caregiver: CaregiverDep, settings: SettingsDep):
    """The buyer reports the UTR from their UPI app.

    Normally grants nothing: it marks the order for a human to look at, and the
    human decides. That is the honest shape of a flow with no gateway callback,
    and it is what the checkout screen tells the buyer is happening.

    With BILLING_AUTOCONFIRM on it grants the month immediately, on the buyer's
    word alone. Nothing here can distinguish a real reference from twelve
    invented digits, so that setting is a demo convenience and a free-month
    dispenser in the same switch. The confirmation it writes is labelled as
    unverified for exactly that reason — an audit of `payments` must stay able to
    separate what a person checked from what was taken on trust.
    """
    async with db.transaction() as conn:
        result = await service.claim(
            conn, caregiver_id=caregiver.id, order_id=body.order_id, utr=body.utr
        )
        if not (settings.billing_autoconfirm and result.get("status") == "claimed"):
            return result

        log.warning(
            "BILLING_AUTOCONFIRM: granting %s on an unverified claim (utr=%s)",
            body.order_id,
            body.utr,
        )
        granted = await service.confirm(conn, utr=body.utr, by=service.AUTO_CONFIRMED_BY)
        if not granted.get("ok"):
            return result
        return {"ok": True, "status": "confirmed", "auto": True}


@router.get("/order/{order_id}")
async def get_order(order_id: str, caregiver: CaregiverDep):
    """Poll target for the screen waiting on confirmation. Scoped to the
    caregiver's own orders, so an order id is not a lookup key for anyone."""
    async with db.connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM payments WHERE id = $1 AND caregiver_id = $2",
            order_id,
            caregiver.id,
        )
    if row is None:
        return {"ok": False, "error": "order_not_found"}
    return {"ok": True, "order": _order_json(row)}


@router.get("/subscription")
async def subscription(caregiver: CaregiverDep):
    """FR-30 — the row a successful payment writes, as the app renders it.

    `pending_order_id` rides along so Settings can say "a payment is being
    verified" instead of offering a second checkout on top of one in flight.
    """
    async with db.connection() as conn:
        sub = await conn.fetchrow(
            "SELECT * FROM subscriptions WHERE caregiver_id = $1", caregiver.id
        )
        pending = await conn.fetchval(
            "SELECT id FROM payments WHERE caregiver_id = $1 "
            "AND status IN ('created','claimed') ORDER BY created_at DESC LIMIT 1",
            caregiver.id,
        )

    if sub is None:
        return {"ok": True, "subscription": None, "pending_order_id": pending}

    plan = plans.PLANS.get(sub["plan"], {})
    return {
        "ok": True,
        "subscription": {
            "plan": sub["plan"],
            "plan_name": plan.get("name", sub["plan"]),
            "status": sub["status"],
            "amount_paise": sub["amount_paise"],
            "current_period_start": sub["current_period_start"],
            "current_period_end": sub["current_period_end"],
        },
        "pending_order_id": pending,
    }
