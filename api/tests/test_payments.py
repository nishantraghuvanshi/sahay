"""Tests for UPI checkout, claim and confirmation. FR-29 · FR-30.

The thing under test is not really the HTTP surface — it is the claim that an
incoming bank credit maps to exactly one order. There is no gateway callback, so
if two open orders can ever await the same amount, a human reconciling a
statement has to guess, and a guess is how somebody gets a month they did not
pay for. Most of what follows is that invariant from several angles.
"""
import hashlib
import os
import secrets
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

os.environ.setdefault("OTP_PEPPER", "a-long-enough-test-pepper-value")
os.environ["KINVOX_SEED"] = "1"

from api import db, main as api_main  # noqa: E402
from api.config import get_settings  # noqa: E402
from api.payments import plans, upi  # noqa: E402

SEEDED_CAREGIVER_PHONE = "+919812345678"
TEST_VPA = "kinvox@upi"


def _sign_in(client: TestClient, caregiver_id: str) -> None:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    con = db.connect()
    try:
        con.execute(
            "INSERT INTO auth_sessions (id, caregiver_id, token_hash, expires_at, "
            "last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                caregiver_id,
                hashlib.sha256(token.encode()).digest(),
                (now + timedelta(days=30)).isoformat(),
                now.isoformat(),
                now.isoformat(),
            ),
        )
        con.commit()
    finally:
        con.close()
    client.cookies.set(get_settings().session_cookie_name, token)


def _caregiver_id(phone: str) -> str:
    con = db.connect()
    try:
        return con.execute(
            "SELECT id FROM caregivers WHERE phone_e164 = ?", (phone,)
        ).fetchone()["id"]
    finally:
        con.close()


@pytest.fixture
def unconfigured_client(tmp_path, monkeypatch):
    """A deployment with no payee VPA — the default everywhere."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    # Set to empty, not deleted. Settings reads `.env` as well as the
    # environment, so deleting the variable only falls through to whatever the
    # developer has configured locally — this test passed until a real VPA was
    # put in `.env`, then started asserting against the machine it ran on. An
    # explicit empty env var wins over the file and pins the state under test.
    monkeypatch.setenv("UPI_PAYEE_VPA", "")
    monkeypatch.setenv("BILLING_AUTOCONFIRM", "false")
    get_settings.cache_clear()
    db.init(reset=True)
    with TestClient(api_main.app) as c:
        _sign_in(c, _caregiver_id(SEEDED_CAREGIVER_PHONE))
        yield c
    get_settings.cache_clear()


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A deployment that can take money, signed in as the seeded caregiver."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setenv("UPI_PAYEE_VPA", TEST_VPA)
    monkeypatch.setenv("UPI_PAYEE_NAME", "Kinvox")
    # Pinned, like the VPA above and for the same reason: every env-backed
    # setting these tests depend on has to be stated here, or the suite quietly
    # starts asserting against whatever the developer has in `.env`.
    monkeypatch.setenv("BILLING_AUTOCONFIRM", "false")
    get_settings.cache_clear()
    db.init(reset=True)
    with TestClient(api_main.app) as c:
        _sign_in(c, _caregiver_id(SEEDED_CAREGIVER_PHONE))
        yield c
    get_settings.cache_clear()


@pytest.fixture
def other_client(client):
    """A second caregiver on the same server."""
    other_id = str(uuid.uuid4())
    con = db.connect()
    try:
        con.execute(
            "INSERT INTO caregivers (id, name, phone_e164, created_at) VALUES (?,?,?,?)",
            (other_id, "Neighbour", "+919700000001",
             datetime.now(timezone.utc).isoformat()),
        )
        con.commit()
    finally:
        con.close()
    c = TestClient(api_main.app)
    _sign_in(c, other_id)
    return c


def _order(client, plan="care"):
    body = client.post("/app/billing/checkout", json={"plan": plan}).json()
    assert body["ok"] is True, body
    return body["order"]


# ---------------------------------------------------------------- the amount


def test_rupees_never_goes_through_a_float():
    """49937/100 is 499.37000000000006 in binary floating point, and some UPI
    apps take that literally and refuse the payment."""
    assert upi.rupees(49_937) == "499.37"
    assert upi.rupees(49_900) == "499.00"
    assert upi.rupees(100) == "1.00"


def test_two_open_orders_never_await_the_same_amount(client):
    """The whole reconciliation scheme in one assertion."""
    amounts = {_order(client)["amount_paise"] for _ in range(12)}
    assert len(amounts) == 12


def test_amount_carries_a_suffix_and_never_the_round_price(client):
    """A payment of exactly ₹499.00 is what somebody sends when they ignore the
    amount we asked for and round it. It must never be attributable to an order."""
    base = plans.price_paise("care")
    for _ in range(5):
        amount = _order(client)["amount_paise"]
        assert base < amount <= base + 99


def test_an_expired_order_releases_its_amount(client):
    first = _order(client)
    con = db.connect()
    try:
        con.execute(
            "UPDATE payments SET expires_at = ? WHERE id = ?",
            ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(), first["order_id"]),
        )
        con.commit()
    finally:
        con.close()

    second = _order(client)
    assert second["amount_paise"] == first["amount_paise"]


# ---------------------------------------------------------------- the price


def test_the_body_cannot_name_a_price(client):
    """A client-supplied amount is a free subscription for anyone with devtools,
    so the request carries a plan key and the server looks the price up."""
    res = client.post(
        "/app/billing/checkout", json={"plan": "care", "amount_paise": 100}
    ).json()
    assert res["ok"] is True
    assert res["order"]["amount_paise"] > plans.price_paise("care")


def test_unknown_plan_is_refused(client):
    assert client.post("/app/billing/checkout", json={"plan": "free_forever"}).json() == {
        "ok": False,
        "error": "unknown_plan",
    }


def test_no_vpa_means_no_checkout(unconfigured_client):
    """Reported, not hidden: the screen has to be able to say payments are not
    switched on here rather than drawing a QR code that points nowhere."""
    assert unconfigured_client.get("/app/billing/plans").json()["configured"] is False
    assert unconfigured_client.post(
        "/app/billing/checkout", json={"plan": "care"}
    ).json() == {"ok": False, "error": "billing_unconfigured"}


# ----------------------------------------------------------------- the link


def test_the_upi_link_omits_merchant_parameters(client):
    """`tr` and `mc` are merchant-mode fields, and several UPI apps reject a
    personal VPA that sends them instead of opening the payment sheet."""
    url = _order(client)["upi_url"]
    assert url.startswith("upi://pay?")
    assert f"pa={TEST_VPA.replace('@', '%40')}" in url
    assert "&tr=" not in url and "&mc=" not in url
    assert "cu=INR" in url


# ----------------------------------------------------------------- claiming


def test_a_claim_grants_nothing(client):
    """It marks the order for a human. Only confirmation buys a month."""
    order = _order(client)
    res = client.post(
        "/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"}
    ).json()
    assert res == {"ok": True, "status": "claimed"}
    assert client.get("/app/billing/subscription").json()["subscription"] is None


@pytest.mark.parametrize("utr", ["12345", "12345678901a", "", "1234567890123"])
def test_a_utr_that_is_not_twelve_digits_is_refused(client, utr):
    order = _order(client)
    assert client.post(
        "/app/billing/claim", json={"order_id": order["order_id"], "utr": utr}
    ).json()["error"] == "bad_utr"


def test_one_utr_cannot_pay_for_two_orders(client):
    """Without this the same real credit could be claimed twice and buy a second
    month nobody paid for."""
    first, second = _order(client), _order(client)
    client.post("/app/billing/claim", json={"order_id": first["order_id"], "utr": "123456789012"})
    res = client.post(
        "/app/billing/claim", json={"order_id": second["order_id"], "utr": "123456789012"}
    ).json()
    assert res == {"ok": False, "error": "utr_already_used"}


def test_a_caregiver_cannot_claim_another_caregivers_order(client, other_client):
    order = _order(client)
    res = other_client.post(
        "/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"}
    ).json()
    assert res == {"ok": False, "error": "order_not_found"}


def test_an_order_id_is_not_a_lookup_key(client, other_client):
    order = _order(client)
    assert other_client.get(f"/app/billing/order/{order['order_id']}").json() == {
        "ok": False,
        "error": "order_not_found",
    }


# ------------------------------------------------------------- confirmation


def _confirm(utr: str, by: str = "test") -> dict:
    import asyncio

    from api.payments import service

    async def run():
        async with db.transaction() as conn:
            return await service.confirm(conn, utr=utr, by=by)

    return asyncio.run(run())


def test_confirmation_writes_the_subscription_the_app_reads(client):
    """FR-30, end to end: the row exists and the caregiver-facing endpoint
    renders it."""
    order = _order(client)
    client.post("/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"})

    assert _confirm("123456789012")["ok"] is True

    body = client.get("/app/billing/subscription").json()
    sub = body["subscription"]
    assert sub["plan"] == "care"
    assert sub["status"] == "active"
    assert sub["amount_paise"] == order["amount_paise"]
    end = datetime.fromisoformat(sub["current_period_end"])
    assert 29 <= (end - datetime.now(timezone.utc)).days <= 30
    # The order is settled, so it no longer reads as a payment in flight.
    assert body["pending_order_id"] is None


def test_confirming_twice_does_not_buy_two_months(client):
    """The CLI is run by a person reading a statement, and a person re-runs
    things."""
    order = _order(client)
    client.post("/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"})

    _confirm("123456789012")
    first_end = client.get("/app/billing/subscription").json()["subscription"][
        "current_period_end"
    ]

    again = _confirm("123456789012")
    assert again["already"] is True
    assert (
        client.get("/app/billing/subscription").json()["subscription"]["current_period_end"]
        == first_end
    )


def test_a_second_payment_extends_from_the_existing_period_end(client):
    """Paying early adds a month to what you have; it does not throw the rest of
    the paid month away."""
    first = _order(client)
    client.post("/app/billing/claim", json={"order_id": first["order_id"], "utr": "123456789012"})
    _confirm("123456789012")
    after_one = datetime.fromisoformat(
        client.get("/app/billing/subscription").json()["subscription"]["current_period_end"]
    )

    second = _order(client)
    client.post("/app/billing/claim", json={"order_id": second["order_id"], "utr": "210987654321"})
    _confirm("210987654321")
    after_two = datetime.fromisoformat(
        client.get("/app/billing/subscription").json()["subscription"]["current_period_end"]
    )

    assert (after_two - after_one).days == plans.PERIOD_DAYS


def test_an_unknown_utr_confirms_nothing(client):
    assert _confirm("999999999999") == {"ok": False, "error": "no_such_utr"}


# ------------------------------------------------------------------- access


def test_billing_is_behind_the_session(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setenv("UPI_PAYEE_VPA", TEST_VPA)
    get_settings.cache_clear()
    db.init(reset=True)
    with TestClient(api_main.app) as anon:
        for method, path in (
            ("get", "/app/billing/subscription"),
            ("post", "/app/billing/checkout"),
            ("post", "/app/billing/claim"),
        ):
            # `.request()` rather than `.get()`/`.post()`: httpx's GET helper
            # takes no json= kwarg, and the point here is that the same body
            # reaches every route.
            res = anon.request(method, path, json={"plan": "care"})
            assert res.status_code == 401, path
    get_settings.cache_clear()


# ------------------------------------------------------- autoconfirm (demo)


@pytest.fixture
def autoconfirm_client(tmp_path, monkeypatch):
    """BILLING_AUTOCONFIRM on: the buyer's claim grants the month by itself."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setenv("UPI_PAYEE_VPA", TEST_VPA)
    monkeypatch.setenv("BILLING_AUTOCONFIRM", "true")
    get_settings.cache_clear()
    db.init(reset=True)
    with TestClient(api_main.app) as c:
        _sign_in(c, _caregiver_id(SEEDED_CAREGIVER_PHONE))
        yield c
    get_settings.cache_clear()


def test_autoconfirm_grants_on_the_claim_alone(autoconfirm_client):
    c = autoconfirm_client
    order = _order(c)
    res = c.post(
        "/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"}
    ).json()
    assert res == {"ok": True, "status": "confirmed", "auto": True}
    assert c.get("/app/billing/subscription").json()["subscription"]["status"] == "active"


def test_an_auto_granted_payment_says_so_on_the_row(autoconfirm_client):
    """The one question this table gets asked later is which payments a person
    actually checked. That has to be answerable from the row."""
    from api.payments.service import AUTO_CONFIRMED_BY

    c = autoconfirm_client
    order = _order(c)
    c.post("/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"})

    con = db.connect()
    try:
        row = con.execute(
            "SELECT confirmed_by FROM payments WHERE id = ?", (order["order_id"],)
        ).fetchone()
    finally:
        con.close()
    assert row["confirmed_by"] == AUTO_CONFIRMED_BY


def test_autoconfirm_still_refuses_a_malformed_utr(autoconfirm_client):
    """Trusting the buyer about the number is not the same as skipping the
    shape check — twelve digits is the one thing still verifiable locally."""
    c = autoconfirm_client
    order = _order(c)
    res = c.post(
        "/app/billing/claim", json={"order_id": order["order_id"], "utr": "nope"}
    ).json()
    assert res == {"ok": False, "error": "bad_utr"}
    assert c.get("/app/billing/subscription").json()["subscription"] is None


def test_it_is_off_by_default(client):
    """The default must never be the free-month dispenser."""
    order = _order(client)
    res = client.post(
        "/app/billing/claim", json={"order_id": order["order_id"], "utr": "123456789012"}
    ).json()
    assert res == {"ok": True, "status": "claimed"}
    assert client.get("/app/billing/subscription").json()["subscription"] is None
