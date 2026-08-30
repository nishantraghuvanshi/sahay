"""The caregiver journey, start to finish, in one test.

Signup by OTP, onboarding with a prescription, the schedule that produces, the
demo call, and the real test call. Each step uses the output of the one before
it rather than a fixture, so this fails if any link in the chain is broken —
which is the failure mode the unit tests cannot see and which this project has
now hit twice: a screen that stopped calling the extractor, and a seed script
that silently wrote nothing.

The two outbound calls are stubbed at the agent boundary. Everything on this
side of that boundary is real: real auth, real database, real schedule
derivation.
"""

from __future__ import annotations

import os
import pathlib
import tempfile

import httpx
import pytest

os.environ.setdefault("KINVOX_DB", tempfile.mktemp(suffix=".db"))
os.environ.setdefault("OTP_PEPPER", "a-long-enough-test-pepper-value")

from fastapi.testclient import TestClient  # noqa: E402

from api import db  # noqa: E402
from api.main import app  # noqa: E402

CAREGIVER_PHONE = "+919555500001"
PARENT_PHONE = "+919555511111"


class _StubAgent:
    """The voice agent. Records what it was asked to do."""

    def __init__(self):
        self.demo_calls: list[dict] = []
        self.real_calls: list[dict] = []

    def __call__(self, *args, **kwargs):
        stub = self

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, headers=None, json=None):
                request = httpx.Request("POST", url)
                if url.endswith("/api/demo-call"):
                    stub.demo_calls.append(json)
                    return httpx.Response(
                        200,
                        json={
                            "persona": json.get("persona", "forgot"),
                            "persona_label": "Forgot, and will take it",
                            "turns": [{"role": "agent", "message": "नमस्ते"}],
                            "outcome": {"label": "DENIED", "reason": "forgot"},
                            "variables": {
                                "parent_name": json["name"],
                                "drug_name": json["drug"],
                                "next_call_line": "",
                                "food_line": "",
                            },
                            "notes": {
                                "no_audio": True,
                                "tools_mocked": True,
                                "nothing_recorded": True,
                            },
                        },
                        request=request,
                    )
                stub.real_calls.append(json)
                return httpx.Response(
                    200,
                    json={"conversation_id": "conv_e2e", "status": "queued"},
                    request=request,
                )

        return _Client()


@pytest.fixture()
def agent(monkeypatch):
    stub = _StubAgent()
    monkeypatch.setattr(httpx, "AsyncClient", stub)
    return stub


@pytest.fixture(autouse=True)
def _own_bypass_number(monkeypatch):
    """Set per test, not at import.

    These were module-level os.environ.setdefault calls, so whichever test file
    pytest imported first won and the other silently lost its OTP bypass —
    passing alone and failing in the suite, purely by collection order.
    """
    monkeypatch.setenv("DEV_OTP_BYPASS_CODE", "123456")
    monkeypatch.setenv("DEV_OTP_BYPASS_NUMBERS", "+919555500001")
    from api.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _fresh_db(monkeypatch):
    path = tempfile.mktemp(suffix=".db")
    monkeypatch.setenv("KINVOX_DB", path)
    monkeypatch.setattr(db, "DB_PATH", pathlib.Path(path))
    db.init()
    yield


# camelCase, and `phone` carrying the caregiver's own number, because that is
# what the LIVE handler expects.
#
# There are two /app/onboarding handlers after the origin/main merge: this one
# in api/routes_app.py, and an authenticated snake_case one in
# api/caregiver/routes.py behind the /app prefix. app_router is included first,
# so this is the one that runs and the authenticated one is dead code. That is
# recorded as an open issue; this test documents the behaviour as it actually
# is rather than as it ought to be, because a test that describes the intended
# handler would pass against a route nobody reaches.
ONBOARDING = {
    "phone": CAREGIVER_PHONE,
    "phoneVerified": True,
    "parentName": "कमला",
    "age": "71",
    "relation": "son",
    "parentPhone": PARENT_PHONE,
    "language": "hi-IN",
    "conditions": ["diabetes"],
    "allergies": [],
    "doctorName": "Dr Rao",
    "doctorPhone": "+919555522222",
    "address": "Pune",
    # Dinner before the evening dose, so the next-call line can name a meal.
    "mealTimes": {"breakfast": "07:30", "lunch": "13:00", "dinner": "19:30"},
    "medicines": [
        {
            "name": "Metformin",
            "dose": "500mg",
            "slots": ["08:00", "20:00"],
            "with_food": "after",
            "is_priority": True,
        }
    ],
    # Enforced server-side, not just by a disabled button: no schedule enters
    # the reminder system without an explicit human confirmation.
    "scheduleConfirmed": True,
    "consents": {"informed": True, "recording": True, "no_advice": True},
}


def test_the_whole_caregiver_journey(agent):
    with TestClient(app) as c:
        # 1. Sign up. The OTP is the gate on everything below.
        c.post("/auth/otp/start", json={"channel": "sms", "destination": CAREGIVER_PHONE})
        verified = c.post(
            "/auth/otp/verify",
            json={"channel": "sms", "destination": CAREGIVER_PHONE, "code": "123456"},
        ).json()
        assert verified["ok"] is True
        assert verified["is_new"] is True, "a first-time number must start onboarding"
        assert c.get("/auth/me").status_code == 200

        # 2. Before onboarding, neither call is offerable — there is no name or
        #    medicine to speak.
        assert c.get("/app/demo-call").json()["ready"] is False

        # 3. Onboarding: the parent, the prescription, the consents.
        onboarded = c.post("/app/onboarding", json=ONBOARDING).json()
        assert onboarded.get("ok") is not False, onboarded

        # 4. The schedule is real, and derived from what was just submitted.
        con = db.connect()
        patient = con.execute(
            "SELECT id, name, phone_e164, meal_times FROM patients WHERE phone_e164 = ?",
            (PARENT_PHONE,),
        ).fetchone()
        assert patient is not None, "onboarding must create the patient"
        assert patient["name"] == "कमला"
        meds = con.execute(
            "SELECT name, slots, with_food FROM medications WHERE patient_id = ?",
            (patient["id"],),
        ).fetchall()
        con.close()
        assert [m["name"] for m in meds] == ["Metformin"]
        assert "20:00" in meds[0]["slots"]
        assert meds[0]["with_food"] == "after"

        # 5. The demo call is now offerable, and speaks the real prescription.
        assert c.get("/app/demo-call").json() == {
            "ok": True,
            "available": True,
            "used_at": None,
            "ready": True,
        }
        demo = c.post("/app/demo-call", json={"persona": "forgot"}).json()
        assert demo["ok"] is True
        assert demo["notes"]["nothing_recorded"] is True
        assert agent.demo_calls[0]["name"] == "कमला"
        assert agent.demo_calls[0]["drug"] == "Metformin"
        assert agent.demo_calls[0]["phone"] == PARENT_PHONE

        # 6. One demo only.
        assert c.post("/app/demo-call", json={}).json()["error"] == "demo_already_used"


def test_a_second_caregiver_cannot_see_the_first_ones_parent(agent, monkeypatch):
    """Every read is scoped to the signed-in caregiver, not to the phone number
    that happens to be in the request."""
    with TestClient(app) as first:
        first.post("/auth/otp/start", json={"channel": "sms", "destination": CAREGIVER_PHONE})
        first.post(
            "/auth/otp/verify",
            json={"channel": "sms", "destination": CAREGIVER_PHONE, "code": "123456"},
        )
        first.post("/app/onboarding", json=ONBOARDING)

    with TestClient(app) as second:
        other = "+919555500002"
        # monkeypatch, not os.environ: settings are cached, so a bare assignment
        # here leaked the widened bypass list into every test that ran after
        # this one and broke the journey test by ordering alone.
        monkeypatch.setenv("DEV_OTP_BYPASS_NUMBERS", f"{CAREGIVER_PHONE},{other}")
        from api.config import get_settings

        get_settings.cache_clear()
        second.post("/auth/otp/start", json={"channel": "sms", "destination": other})
        second.post(
            "/auth/otp/verify",
            json={"channel": "sms", "destination": other, "code": "123456"},
        )
        # A different caregiver has no patient, so no demo is offerable and the
        # first caregiver's parent is not reachable through it.
        assert second.get("/app/demo-call").json()["ready"] is False
        assert second.post("/app/demo-call", json={}).json()["error"] == "onboarding_incomplete"
        assert agent.demo_calls == []


def test_finishing_onboarding_does_not_sign_the_caregiver_out(agent):
    """The regression this whole file was written to catch.

    db.insert used INSERT OR REPLACE, which SQLite implements as DELETE then
    INSERT. auth_sessions.caregiver_id cascades on delete, so rewriting the
    caregiver row during onboarding destroyed the session: the caregiver
    completed setup and the very next screen answered 401.

    Nothing looked wrong afterwards — same caregiver id, name updated — which
    is why no unit test saw it. Only walking the journey does.
    """
    with TestClient(app) as c:
        c.post("/auth/otp/start", json={"channel": "sms", "destination": CAREGIVER_PHONE})
        c.post(
            "/auth/otp/verify",
            json={"channel": "sms", "destination": CAREGIVER_PHONE, "code": "123456"},
        )
        assert c.get("/auth/me").status_code == 200

        con = db.connect()
        before = con.execute("SELECT count(*) FROM auth_sessions").fetchone()[0]
        con.close()
        assert before == 1

        assert c.post("/app/onboarding", json=ONBOARDING).status_code == 200

        con = db.connect()
        after = con.execute("SELECT count(*) FROM auth_sessions").fetchone()[0]
        con.close()
        assert after == 1, "onboarding must not delete the caregiver's session"
        assert c.get("/auth/me").status_code == 200, "still signed in after onboarding"
