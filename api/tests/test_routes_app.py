"""Tests for the caregiver-app endpoints and the onboarding write.

Every test runs against a throwaway SQLite file seeded from the same fixture the
app was built against, so a shape change here fails loudly rather than showing up
as an empty screen.
"""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api import db, main as api_main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init(reset=True)
    with TestClient(api_main.app) as c:
        yield c


def draft(**over):
    base = {
        "phone": "+919812345678", "email": "a@b.com",
        "phoneVerified": True, "emailVerified": True,
        "parentName": "Kamala", "honorific": "ji", "age": "71", "relation": "son",
        "parentPhone": "+919000000042", "language": "hi-IN",
        "conditions": ["hypertension"], "allergies": ["sulfa"],
        "mealTimes": {"breakfast": "07:30", "lunch": "13:00", "dinner": "20:00"},
        "escalation": [{"name": "Priya", "relationship": "daughter", "after": "30"}],
        "medicines": [{
            "name": "Pan-D 40", "dose": "40mg", "slots": ["08:00", "20:30"],
            "with_food": "after", "is_priority": True, "unclear": False,
            "raw_line": "1) T. Pan-D 40 40mg 1-0-1 x 5 days (a/f)", "confidence": 0.98,
            "flags": [], "duration_days": 5, "excluded": False, "exclusion_reason": None,
        }],
        "scheduleConfirmed": True,
        "introCall": "later", "introCallAt": "2026-08-31T10:30:00+05:30",
        "consents": {"informed": True, "recording": True, "no_advice": True},
        "extraction": {"doc_id": "rx_test_0001"},
    }
    base.update(over)
    return base


# --------------------------------------------------------------- read shapes

def test_seeded_record_matches_the_shape_the_app_renders(client):
    body = client.get("/app/record").json()
    assert set(body) == {"patient", "caregiver", "medications"}
    # Booleans must be real booleans, not SQLite's 0/1 — the app branches on them.
    assert isinstance(body["patient"]["calls_paused"], bool)
    assert isinstance(body["medications"][0]["is_priority"], bool)
    # JSON columns come back parsed, not as strings.
    assert isinstance(body["patient"]["conditions"], list)
    assert isinstance(body["medications"][0]["slots"], list)
    assert isinstance(body["patient"]["meal_times"], dict)


@pytest.mark.parametrize("path", ["/app/doses", "/app/observations", "/app/escalations", "/app/calls"])
def test_list_endpoints_return_bare_arrays(client, path):
    """client.ts does `return body as T` — an envelope around a list breaks every
    screen that maps over it."""
    body = client.get(path).json()
    assert isinstance(body, list)


def test_summary_has_every_field_the_home_screen_reads(client):
    body = client.get("/app/summary").json()
    assert set(body) == {"since", "items", "doses_confirmed", "doses_total", "calls", "alerts"}


def test_missing_intake_returns_a_code_the_client_can_humanise(client):
    """A bare 404 would surface as "The Care API returned 404." — the `{ok:false}`
    envelope is what lets client.ts print a sentence a worried adult child reads."""
    r = client.get("/app/intake/nope")
    assert r.status_code == 200
    assert r.json() == {"ok": False, "error": "not_found"}


def test_unknown_handoff_token_is_not_found(client):
    assert client.get("/h/nosuchtoken").json()["error"] == "not_found"


# ------------------------------------------------------------ onboarding gate

def test_an_unsigned_schedule_is_refused(client):
    """FR-4 / design doc S1. The rule cannot live only in a disabled button —
    anything can POST."""
    r = client.post("/app/onboarding", json=draft(scheduleConfirmed=False))
    assert r.json() == {"ok": False, "error": "schedule_not_signed_off"}
    # and nothing was written
    assert client.get("/app/record").json()["patient"]["name"] != "Kamala"


def test_two_priority_medicines_are_refused(client):
    d = draft()
    d["medicines"] = [
        {**d["medicines"][0], "name": "A", "is_priority": True},
        {**d["medicines"][0], "name": "B", "is_priority": True},
    ]
    assert client.post("/app/onboarding", json=d).json()["error"] == "multiple_priority_medicines"


def test_an_empty_schedule_is_refused(client):
    assert client.post("/app/onboarding", json=draft(medicines=[])).json()["error"] == "no_medicines"


# ------------------------------------------------------------- onboarding write

def test_onboarding_round_trips_into_the_record(client):
    assert client.post("/app/onboarding", json=draft()).json()["ok"] is True

    body = client.get("/app/record").json()
    assert body["patient"]["name"] == "Kamala"
    assert body["patient"]["meal_times"]["breakfast"] == "07:30"
    assert body["patient"]["age"] == 71
    # The FR-4 gate is set by the POST, and only because the draft was signed off.
    assert body["patient"]["schedule_signed_off_at"]


def test_provenance_survives_confirmation(client):
    """SCHEMA-GAPS §7 / safety rule S3: the verbatim reading must not be discarded
    the moment a caregiver signs the schedule off."""
    client.post("/app/onboarding", json=draft())
    med = client.get("/app/record").json()["medications"][0]

    assert med["raw_line"] == "1) T. Pan-D 40 40mg 1-0-1 x 5 days (a/f)"
    assert med["confidence"] == 0.98
    assert med["source"] == "prescription"
    assert med["source_doc_id"] == "rx_test_0001"
    assert med["duration_days"] == 5
    # design doc §10 — required, not nullable-with-a-default.
    assert med["confirmed_by"] and med["confirmed_at"]


def test_a_hand_typed_medicine_is_not_labelled_as_read_from_a_prescription(client):
    d = draft()
    d["medicines"] = [{**d["medicines"][0], "raw_line": None, "confidence": None}]
    client.post("/app/onboarding", json=d)
    assert client.get("/app/record").json()["medications"][0]["source"] == "manual"


def test_intro_call_is_recorded_as_pending_and_reaches_the_calendar(client):
    client.post("/app/onboarding", json=draft())
    p = client.get("/app/record").json()["patient"]

    assert p["intro_call_at"] == "2026-08-31T10:30:00+05:30"
    # Load-bearing: the scheduler must not dial a dose slot until this is 'done'.
    assert p["intro_call_status"] == "pending"


def test_calling_now_marks_the_intro_call_done(client):
    client.post("/app/onboarding", json=draft(introCall="now", introCallAt=None))
    assert client.get("/app/record").json()["patient"]["intro_call_status"] == "done"


def test_consents_are_stored_with_a_timestamp_not_as_bare_booleans(client):
    client.post("/app/onboarding", json=draft())
    consents = client.get("/app/record").json()["patient"]["consents"]
    assert {c["id"] for c in consents} == {"informed", "recording", "no_advice"}
    assert all(c["agreed"] and c["agreed_at"] for c in consents)


def test_an_excluded_medicine_is_stored_with_no_slots(client):
    """Safety rule 4 — an SOS medicine kept as an ordinary row with no slots would
    start being called about as soon as anything defaulted a time into it."""
    d = draft()
    d["medicines"].append({
        "name": "Mixtard", "dose": "", "slots": [], "with_food": "any",
        "is_priority": False, "unclear": False, "raw_line": "2) Inj. Mixtard SOS",
        "confidence": 0.88, "flags": ["exclude_from_calls"], "duration_days": None,
        "excluded": True, "exclusion_reason": "Taken as needed (SOS) — no reminder is scheduled.",
    })
    client.post("/app/onboarding", json=d)

    med = [m for m in client.get("/app/record").json()["medications"] if m["name"] == "Mixtard"][0]
    assert med["excluded"] is True
    assert med["slots"] == []
    assert "SOS" in med["exclusion_reason"]


def test_re_running_onboarding_replaces_the_schedule_rather_than_merging(client):
    """The POST represents one signed-off list. Merging it with an older one would
    produce a schedule nobody ever signed."""
    client.post("/app/onboarding", json=draft())
    d = draft()
    d["medicines"] = [{**d["medicines"][0], "name": "Dolo 650"}]
    client.post("/app/onboarding", json=d)

    names = [m["name"] for m in client.get("/app/record").json()["medications"]]
    assert names == ["Dolo 650"]


def test_re_running_onboarding_does_not_collide_on_the_unique_phone_index(client):
    assert client.post("/app/onboarding", json=draft()).json()["ok"] is True
    second = client.post("/app/onboarding", json=draft())
    assert second.json()["ok"] is True


def test_escalation_contacts_are_kept_even_though_they_have_no_number(client):
    """SCHEMA-GAPS §5 — onboarding still collects no phone number for these people,
    so the ladder cannot dial. Storing them beats dropping them on the floor."""
    client.post("/app/onboarding", json=draft())
    con = db.connect()
    try:
        rows = con.execute("SELECT * FROM escalation_contacts").fetchall()
    finally:
        con.close()
    assert [r["name"] for r in rows] == ["Priya"]
    assert rows[0]["phone_e164"] is None
    assert rows[0]["after_minutes"] == 30


def test_restarting_does_not_overwrite_a_signed_off_schedule(client):
    """Seeding runs only on an empty database."""
    client.post("/app/onboarding", json=draft())
    db.init()  # as a restart would
    assert client.get("/app/record").json()["patient"]["name"] == "Kamala"
