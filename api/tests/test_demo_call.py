"""The optional demo call: one per caregiver, no phone rings, nothing recorded.

These exercise the API layer only. The agent is stubbed, because what is being
tested here is the gate — who may take a demo, how many times, and what happens
when the agent is down — not the conversation itself, which the agent's own
tests cover.
"""

from __future__ import annotations

import os
import tempfile

import httpx
import pytest

os.environ.setdefault("KINVOX_DB", tempfile.mktemp(suffix=".db"))
os.environ.setdefault("OTP_PEPPER", "a-long-enough-test-pepper-value")

from fastapi.testclient import TestClient  # noqa: E402

from api import db  # noqa: E402
from api.main import app  # noqa: E402

TRANSCRIPT = {
    "persona": "forgot",
    "persona_label": "Forgot, and will take it",
    "turns": [
        {"role": "agent", "message": "नमस्ते, क्या आपने ले लिया है?"},
        {"role": "user", "message": "नहीं"},
        {"role": "tool", "tool": "report_outcome", "args": {"outcome": "DENIED"}},
    ],
    "outcome": {"label": "DENIED", "reason": "forgot"},
    "variables": {"parent_name": "कमला", "drug_name": "Metformin"},
    "notes": {"no_audio": True, "tools_mocked": True, "nothing_recorded": True},
}


def _signed_in(client: TestClient, phone: str = "+919999900001") -> None:
    client.post("/auth/otp/start", json={"channel": "sms", "destination": phone})
    r = client.post(
        "/auth/otp/verify",
        json={"channel": "sms", "destination": phone, "code": "123456"},
    )
    assert r.json()["ok"], r.json()


def _give_patient(caregiver_phone: str = "+919999900001") -> None:
    """Onboarding done: a demo needs a name and a medicine to speak."""
    con = db.connect()
    cg = con.execute(
        "SELECT id FROM caregivers WHERE phone_e164 = ?", (caregiver_phone,)
    ).fetchone()
    con.execute(
        "INSERT INTO patients (id, caregiver_id, name, phone_e164, language, "
        "conditions, allergies, timezone, calls_paused, created_at) "
        "VALUES ('pt-demo', ?, 'कमला', '+919998800001', 'hi-IN', '[]', '[]', "
        "'Asia/Kolkata', 0, '2026-01-01T00:00:00+00:00')",
        (cg["id"],),
    )
    con.execute(
        "INSERT INTO medications (id, patient_id, name, dose, slots, is_priority, "
        "start_date, source, extraction_flags, excluded) "
        "VALUES ('md-demo', 'pt-demo', 'Metformin', '500mg', '[\"08:00\"]', 1, "
        "'2026-01-01', 'manual', '[]', 0)"
    )
    con.commit()
    con.close()


class _StubAgent:
    """Stands in for the agent service, recording what the API sent it."""

    def __init__(self, *, status=200, payload=None, raises=False):
        self.status = status
        self.payload = payload if payload is not None else TRANSCRIPT
        self.raises = raises
        self.seen: dict | None = None

    def __call__(self, *args, **kwargs):
        stub = self

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, headers=None, json=None):
                if stub.raises:
                    raise httpx.ConnectError("agent down")
                stub.seen = {"url": url, "json": json, "headers": headers}
                return httpx.Response(
                    stub.status, json=stub.payload, request=httpx.Request("POST", url)
                )

        return _Client()


@pytest.fixture(autouse=True)
def _own_bypass_number(monkeypatch):
    """Set per test, not at import.

    These were module-level os.environ.setdefault calls, so whichever test file
    pytest imported first won and the other silently lost its OTP bypass —
    passing alone and failing in the suite, purely by collection order.
    """
    monkeypatch.setenv("DEV_OTP_BYPASS_CODE", "123456")
    monkeypatch.setenv("DEV_OTP_BYPASS_NUMBERS", "+919999900001")
    from api.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _fresh_db(monkeypatch):
    path = tempfile.mktemp(suffix=".db")
    monkeypatch.setenv("KINVOX_DB", path)
    monkeypatch.setattr(db, "DB_PATH", __import__("pathlib").Path(path))
    db.init()
    yield


def test_demo_requires_a_signed_in_caregiver():
    with TestClient(app) as c:
        assert c.post("/app/demo-call", json={}).status_code == 401
        assert c.get("/app/demo-call").status_code == 401


def test_demo_refuses_before_onboarding_is_finished(monkeypatch):
    stub = _StubAgent()
    monkeypatch.setattr(httpx, "AsyncClient", stub)
    with TestClient(app) as c:
        _signed_in(c)
        body = c.post("/app/demo-call", json={}).json()
        assert body["ok"] is False
        assert body["error"] == "onboarding_incomplete"
        # The agent must not have been troubled at all.
        assert stub.seen is None


def test_demo_returns_the_transcript_and_speaks_the_real_patient(monkeypatch):
    stub = _StubAgent()
    monkeypatch.setattr(httpx, "AsyncClient", stub)
    with TestClient(app) as c:
        _signed_in(c)
        _give_patient()
        body = c.post("/app/demo-call", json={"persona": "forgot"}).json()
        assert body["ok"] is True
        assert body["outcome"]["label"] == "DENIED"
        assert [t["role"] for t in body["turns"]] == ["agent", "user", "tool"]
        # The agent was asked about this caregiver's actual parent and medicine.
        assert stub.seen["json"]["name"] == "कमला"
        assert stub.seen["json"]["drug"] == "Metformin"
        assert stub.seen["json"]["phone"] == "+919998800001"
        assert stub.seen["json"]["persona"] == "forgot"


def test_the_demo_says_what_it_did_not_do(monkeypatch):
    # A caregiver must not read this as a rehearsal, or as something that
    # recorded a dose.
    monkeypatch.setattr(httpx, "AsyncClient", _StubAgent())
    with TestClient(app) as c:
        _signed_in(c)
        _give_patient()
        body = c.post("/app/demo-call", json={}).json()
        assert body["notes"] == {
            "no_audio": True,
            "tools_mocked": True,
            "nothing_recorded": True,
        }


def test_only_one_demo_per_caregiver(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _StubAgent())
    with TestClient(app) as c:
        _signed_in(c)
        _give_patient()
        assert c.post("/app/demo-call", json={}).json()["ok"] is True
        second = c.post("/app/demo-call", json={}).json()
        assert second["ok"] is False
        assert second["error"] == "demo_already_used"
        assert second["used_at"]


def test_status_reports_whether_the_demo_is_still_available(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _StubAgent())
    with TestClient(app) as c:
        _signed_in(c)
        before = c.get("/app/demo-call").json()
        assert before["available"] is True
        assert before["ready"] is False  # no patient yet
        _give_patient()
        assert c.get("/app/demo-call").json()["ready"] is True
        c.post("/app/demo-call", json={})
        after = c.get("/app/demo-call").json()
        assert after["available"] is False
        assert after["used_at"]


def test_an_unreachable_agent_does_not_burn_the_demo(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _StubAgent(raises=True))
    with TestClient(app) as c:
        _signed_in(c)
        _give_patient()
        body = c.post("/app/demo-call", json={}).json()
        assert body["ok"] is False
        assert body["error"] == "agent_unreachable"
        # Our outage, not theirs: the one demo they get is still there.
        assert c.get("/app/demo-call").json()["available"] is True


def test_an_agent_error_does_not_burn_the_demo(monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", _StubAgent(status=503, payload={"error": "not_configured"}))
    with TestClient(app) as c:
        _signed_in(c)
        _give_patient()
        body = c.post("/app/demo-call", json={}).json()
        assert body["ok"] is False
        assert body["error"] == "demo_failed"
        assert c.get("/app/demo-call").json()["available"] is True
