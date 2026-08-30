"""Which page a person belongs on — /login or /signup — and how they find out.

The bug these pin: auth answered every failure vaguely, on purpose, and the two
dead ends people actually hit had no way out of them.

  * A first-time caregiver typed a password into /login and was told the phone
    and password "do not match". They had no password. Nothing on the screen
    said sign up first, and trying harder could never work.
  * A returning caregiver started /signup, got a real SMS, typed a real code,
    and only discovered at step 5 that the account had existed all along.

`/auth/check` is the endpoint that answers the question, and `no_account` /
`signup_incomplete` are the login codes that name the two states. Both leak
whether an account exists, which is the trade recorded in api/auth/routes.py.
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

from api import db, main as api_main  # noqa: E402
from api.auth import password as pw, routes as auth_routes  # noqa: E402
from api.config import get_settings  # noqa: E402

FULL = "+919812345678"      # signed up, password set — belongs on /login
HALF = "+919700000001"      # phone verified, never finished step 5
NOBODY = "+919600000002"    # no row at all


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    # Seeding off: pytest imports every test module before running any of them,
    # and api/tests/test_routes_app.py sets VOXIKIN_SEED=1 at import time. The
    # fixture household owns +919812345678, which is this file's FULL — so the
    # inserts below collided with a row this file never asked for.
    monkeypatch.setenv("VOXIKIN_SEED", "0")
    get_settings.cache_clear()
    db.init(reset=True)
    # The per-IP throttle is process-global and every test here shares one IP.
    auth_routes._check_hits.clear()

    now = datetime.now(timezone.utc).isoformat()
    digest, salt = pw.hash_password("correct-horse-battery")
    con = db.connect()
    try:
        con.execute(
            "INSERT INTO caregivers (id, name, phone_e164, email, phone_verified_at, "
            "password_hash, password_salt, password_set_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), "Asha", FULL, "asha@example.com", now,
             digest, salt, now, now),
        )
        con.execute(
            "INSERT INTO caregivers (id, name, phone_e164, phone_verified_at, created_at) "
            "VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), "", HALF, now, now),
        )
        con.commit()
    finally:
        con.close()

    with TestClient(api_main.app) as c:
        yield c


# ------------------------------------------------------------------- /auth/check


def test_check_knows_a_finished_account(client):
    body = client.post("/auth/check", json={"identifier": FULL}).json()
    assert body == {"ok": True, "unknown": False, "exists": True, "has_password": True}


def test_check_finds_the_same_account_by_email(client):
    """The login box takes either, so the check has to accept either."""
    body = client.post("/auth/check", json={"identifier": "ASHA@example.com"}).json()
    assert body["exists"] is True and body["has_password"] is True


def test_check_normalises_the_way_people_type_a_number(client):
    """Spaced exactly as the login placeholder shows it. A check that said "no
    account" here would send a signed-up caregiver round to /signup."""
    body = client.post("/auth/check", json={"identifier": "+91 98123 45678"}).json()
    assert body["exists"] is True


def test_check_separates_a_half_finished_signup(client):
    """Exists, but has no password. Sending this one to /login would be a loop:
    there is nothing they could type that the form would accept."""
    body = client.post("/auth/check", json={"identifier": HALF}).json()
    assert body["exists"] is True
    assert body["has_password"] is False


def test_check_says_no_for_a_stranger(client):
    body = client.post("/auth/check", json={"identifier": NOBODY}).json()
    assert body["exists"] is False and body["unknown"] is False


def test_check_answers_unknown_rather_than_guessing_when_throttled(client):
    """Over the limit it must not say `exists: false` about an account that does
    exist — the caller would confidently send its owner to signup. `unknown`
    means the UI falls back to the vague wording it had before."""
    for _ in range(auth_routes.CHECK_MAX_PER_IP_HOUR):
        client.post("/auth/check", json={"identifier": NOBODY})

    body = client.post("/auth/check", json={"identifier": FULL}).json()
    assert body["unknown"] is True
    assert body["exists"] is False  # not an assertion about FULL — see `unknown`


# ------------------------------------------------------------------- /auth/login


def test_login_names_the_missing_account(client):
    body = client.post(
        "/auth/login", json={"identifier": NOBODY, "password": "anything-at-all"}
    ).json()
    assert body == {"ok": False, "error": "no_account"}


def test_login_names_an_unfinished_signup(client):
    """Not `invalid_credentials`: there is no credential to be invalid."""
    body = client.post(
        "/auth/login", json={"identifier": HALF, "password": "anything-at-all"}
    ).json()
    assert body == {"ok": False, "error": "signup_incomplete"}


def test_login_still_refuses_a_wrong_password_on_a_real_account(client):
    body = client.post(
        "/auth/login", json={"identifier": FULL, "password": "not-the-password"}
    ).json()
    assert body == {"ok": False, "error": "invalid_credentials"}


def test_login_works(client):
    res = client.post(
        "/auth/login", json={"identifier": "+91 98123 45678", "password": "correct-horse-battery"}
    )
    body = res.json()
    assert body["ok"] is True
    assert body["caregiver"]["name"] == "Asha"
    assert res.cookies.get(get_settings().session_cookie_name)


def test_a_wrong_password_still_counts_toward_the_lockout(client):
    """The new codes must not have skipped the failure counter on their way past."""
    for _ in range(pw.MAX_FAILED_LOGINS):
        client.post("/auth/login", json={"identifier": FULL, "password": "wrong"})

    body = client.post(
        "/auth/login", json={"identifier": FULL, "password": "correct-horse-battery"}
    ).json()
    assert body == {"ok": False, "error": "account_locked"}


def test_a_missing_account_never_reaches_the_lockout_counter(client):
    """There is no row to count against, so hammering an unknown number must not
    500 on the way to saying `no_account`."""
    for _ in range(pw.MAX_FAILED_LOGINS + 2):
        body = client.post(
            "/auth/login", json={"identifier": NOBODY, "password": "wrong"}
        ).json()
        assert body["error"] == "no_account"


# --------------------------------------------------- the pairing, end to end


def test_check_and_login_agree_about_every_account(client):
    """The UI trusts these two to tell the same story: /login's `no_account`
    sends someone to /signup, and /signup's check has to agree they belong
    there, or the two pages bounce a caregiver between them forever."""
    for identifier in (FULL, HALF, NOBODY):
        check = client.post("/auth/check", json={"identifier": identifier}).json()
        login = client.post(
            "/auth/login", json={"identifier": identifier, "password": "x"}
        ).json()

        if not check["exists"]:
            assert login["error"] == "no_account"
        elif not check["has_password"]:
            assert login["error"] == "signup_incomplete"
        else:
            assert login["error"] == "invalid_credentials"
