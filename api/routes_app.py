"""Caregiver-app endpoints. spec: TRD §5.1, §11

These are the read endpoints `app/src/api/hooks.ts` calls, plus the one write that
turns a completed onboarding into a real record.

Two conventions the app depends on:

* **Payloads are bare.** `client.ts` does `return body as T`, so a list endpoint
  must return a JSON array and not an envelope around one. Only failures carry
  `{ok: false, error}`, and they come back HTTP 200 because `humanise()` in the
  client turns the error *code* into the sentence a caregiver reads — a raw 404
  would lose that (NFR-6).
* **No auth, one household.** NFR-7 says the browser only ever sees
  caregiver-scoped reads, and there is no session layer yet, so "the caregiver" is
  the most recently created one. That is a demo simplification and the only place
  it lives is `current_patient()` below.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from fastapi.responses import JSONResponse

from api import db

router = APIRouter()

BOOL_COLUMNS = {"is_priority", "calls_paused", "excluded", "safety_pass", "consent_ack"}


def _row(table: str, row) -> dict:
    """DB row -> the JSON the app's TypeScript types expect."""
    out = db.decode(table, row)
    for col in BOOL_COLUMNS:
        if col in out and out[col] is not None:
            out[col] = bool(out[col])
    return out


def _fail(error: str):
    """`{ok:false}` at HTTP 200 — the client maps the code to a human sentence."""
    return JSONResponse(status_code=200, content={"ok": False, "error": error})


def current_patient(con):
    return con.execute("SELECT * FROM patients ORDER BY created_at DESC LIMIT 1").fetchone()


# --------------------------------------------------------------------- reads

@router.get("/app/record")
def get_record():
    con = db.connect()
    try:
        patient = current_patient(con)
        if patient is None:
            return _fail("not_found")
        caregiver = con.execute(
            "SELECT * FROM caregivers WHERE id = ?", (patient["caregiver_id"],)
        ).fetchone()
        meds = con.execute(
            "SELECT * FROM medications WHERE patient_id = ? ORDER BY rowid", (patient["id"],)
        ).fetchall()
        return {
            "patient": _row("patients", patient),
            "caregiver": _row("caregivers", caregiver),
            "medications": [_row("medications", m) for m in meds],
        }
    finally:
        con.close()


@router.get("/app/doses")
def get_doses():
    con = db.connect()
    try:
        patient = current_patient(con)
        if patient is None:
            return []
        rows = con.execute(
            "SELECT * FROM dose_events WHERE patient_id = ? ORDER BY slot_time", (patient["id"],)
        ).fetchall()
        return [_row("dose_events", r) for r in rows]
    finally:
        con.close()


@router.get("/app/observations")
def get_observations():
    con = db.connect()
    try:
        patient = current_patient(con)
        if patient is None:
            return []
        rows = con.execute(
            "SELECT * FROM observations WHERE patient_id = ? ORDER BY created_at DESC",
            (patient["id"],),
        ).fetchall()
        return [_row("observations", r) for r in rows]
    finally:
        con.close()


@router.get("/app/escalations")
def get_escalations():
    con = db.connect()
    try:
        patient = current_patient(con)
        if patient is None:
            return []
        rows = con.execute(
            "SELECT * FROM escalations WHERE patient_id = ? ORDER BY sent_at DESC",
            (patient["id"],),
        ).fetchall()
        return [_row("escalations", r) for r in rows]
    finally:
        con.close()


@router.get("/app/calls")
def get_calls():
    con = db.connect()
    try:
        patient = current_patient(con)
        if patient is None:
            return []
        rows = con.execute(
            "SELECT * FROM call_sessions WHERE patient_id = ? ORDER BY started_at DESC",
            (patient["id"],),
        ).fetchall()
        return [_row("call_sessions", r) for r in rows]
    finally:
        con.close()


@router.get("/app/intake/{record_id}")
def get_intake(record_id: str):
    con = db.connect()
    try:
        row = con.execute("SELECT * FROM intake_records WHERE id = ?", (record_id,)).fetchone()
        if row is None:
            return _fail("not_found")
        return _row("intake_records", row)
    finally:
        con.close()


@router.get("/app/summary")
def get_summary():
    """Today's roll-up. Derived on read, never stored (wireframe 1f).

    Mirrors the derivation in app/src/api/mock.ts so the live screen and the mock
    screen cannot disagree about what "today so far" means.
    """
    con = db.connect()
    try:
        patient = current_patient(con)
        since = datetime.now().astimezone().replace(hour=6, minute=0, second=0, microsecond=0)
        empty = {
            "since": since.isoformat(), "items": [],
            "doses_confirmed": 0, "doses_total": 0, "calls": 0, "alerts": 0,
        }
        if patient is None:
            return empty

        pid = patient["id"]
        med_name = {
            m["id"]: m["name"]
            for m in con.execute("SELECT id, name FROM medications WHERE patient_id = ?", (pid,))
        }

        def parsed(value):
            """ISO string -> aware datetime, or None.

            Anything stored without an offset is read as UTC. A naive datetime
            compared against an aware one raises TypeError, which would turn one
            malformed row into a 500 for the entire summary.
            """
            try:
                dt = datetime.fromisoformat(value)
            except (TypeError, ValueError):
                return None
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

        items = []

        now = datetime.now(timezone.utc)
        for d in con.execute("SELECT * FROM dose_events WHERE patient_id = ?", (pid,)):
            at = parsed(d["slot_time"])
            if at is None or not (since <= at <= now):
                continue
            name = med_name.get(d["medication_id"], "Medicine")
            status = d["status"]
            text = (
                f"{name} confirmed" if status == "confirmed"
                else f"{name} missed" + (f" — {d['note']}" if d["note"] else "") if status == "missed"
                else f"{name} — no answer" if status == "no_answer"
                # Never "missed": nothing was established about this dose.
                else f"{name} — could not reach them" if status == "unknown"
                else f"{name} deferred"
            )
            items.append({"at": d["slot_time"], "kind": "dose", "status": status,
                          "text": text, "href": "/doses"})

        for c in con.execute("SELECT * FROM call_sessions WHERE patient_id = ?", (pid,)):
            at = parsed(c["started_at"])
            if at is None or at < since:
                continue
            text = (
                "Check-in call not answered" if c["status"] == "no_answer"
                else f"{patient['name']} called in" if c["direction"] == "in"
                else "Check-in call answered"
            )
            items.append({"at": c["started_at"], "kind": "call", "text": text,
                          "href": f"/calls/{c['id']}"})

        for o in con.execute("SELECT * FROM observations WHERE patient_id = ?", (pid,)):
            at = parsed(o["created_at"])
            if at is None or at < since:
                continue
            items.append({"at": o["created_at"], "kind": "observation",
                          "severity": o["severity"], "text": o["text"], "href": "/observations"})

        for e in con.execute("SELECT * FROM escalations WHERE patient_id = ?", (pid,)):
            at = parsed(e["sent_at"]) if e["sent_at"] else None
            if at is None or at < since:
                continue
            items.append({"at": e["sent_at"], "kind": "escalation",
                          "text": f"{e['level']} — {e['reason']}", "href": f"/alerts/{e['id']}"})

        items.sort(key=lambda i: i["at"])

        today = datetime.now().astimezone().date()
        todays = [
            d for d in con.execute("SELECT * FROM dose_events WHERE patient_id = ?", (pid,))
            if (p := parsed(d["slot_time"])) is not None and p.astimezone().date() == today
        ]
        return {
            "since": since.isoformat(),
            "items": items,
            "doses_confirmed": sum(1 for d in todays if d["status"] == "confirmed"),
            "doses_total": len(todays),
            "calls": sum(1 for i in items if i["kind"] == "call"),
            "alerts": sum(1 for i in items if i["kind"] == "escalation"),
        }
    finally:
        con.close()


@router.get("/h/{token}")
def get_handoff(token: str):
    """TRD §11 — everything the recipient needs, nothing else."""
    con = db.connect()
    try:
        h = con.execute("SELECT * FROM handoffs WHERE token = ?", (token,)).fetchone()
        if h is None:
            return _fail("not_found")
        if h["expires_at"]:
            try:
                if datetime.fromisoformat(h["expires_at"]) < datetime.now(timezone.utc):
                    return _fail("expired")
            except ValueError:
                pass

        intake = con.execute(
            "SELECT * FROM intake_records WHERE id = ?", (h["intake_record_id"],)
        ).fetchone()
        if intake is None:
            return _fail("not_found")

        patient = con.execute(
            "SELECT * FROM patients WHERE id = ?", (intake["patient_id"],)
        ).fetchone() or current_patient(con)
        if patient is None:
            return _fail("not_found")

        p = _row("patients", patient)
        meds = con.execute(
            "SELECT * FROM medications WHERE patient_id = ? ORDER BY rowid", (patient["id"],)
        ).fetchall()

        # Mark it seen. A handoff nobody opened and one opened an hour ago are
        # different facts to the person who sent it.
        if h["viewed_at"] is None:
            con.execute("UPDATE handoffs SET viewed_at = ? WHERE id = ?", (db.now_iso(), h["id"]))
            con.commit()

        return {
            "patient": {k: p[k] for k in
                        ("name", "honorific", "age", "conditions", "allergies", "address_text")},
            "medications": [
                {k: _row("medications", m)[k] for k in ("name", "dose", "slots", "with_food")}
                for m in meds
            ],
            "intake": _row("intake_records", intake),
            "callback_number": p["phone_e164"],
            "viewed_at": h["viewed_at"],
            "expires_at": h["expires_at"],
        }
    finally:
        con.close()


# -------------------------------------------------------------------- write

class OnboardingMedicine(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    dose: str = ""
    slots: list[str] = Field(default_factory=list)
    with_food: str | None = "any"
    is_priority: bool = False
    unclear: bool = False
    raw_line: str | None = None
    confidence: float | None = None
    flags: list[str] = Field(default_factory=list)
    duration_days: int | None = None
    excluded: bool = False
    exclusion_reason: str | None = None


class EscalationContact(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = ""
    relationship: str | None = None
    after: str | None = None


class Onboarding(BaseModel):
    """The onboarding draft from app/src/setup/store.ts."""

    model_config = ConfigDict(extra="ignore")

    phone: str = ""
    email: str = ""
    phoneVerified: bool = False
    emailVerified: bool = False

    parentName: str
    honorific: str | None = None
    age: str | None = None
    relation: str | None = None
    parentPhone: str
    language: str = "hi-IN"
    conditions: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    doctorName: str | None = None
    doctorPhone: str | None = None
    address: str | None = None
    mealTimes: dict[str, str] | None = None
    escalation: list[EscalationContact] = Field(default_factory=list)

    medicines: list[OnboardingMedicine] = Field(default_factory=list)
    scheduleConfirmed: bool = False

    introCall: str | None = None
    introCallAt: str | None = None
    consents: dict[str, bool] = Field(default_factory=dict)

    extraction: dict | None = None


@router.post("/app/onboarding")
def post_onboarding(body: Onboarding):
    """Turn a completed onboarding into a real record.

    The sign-off is enforced here, not just in the UI. FR-4 and design doc §2 (S1)
    say no schedule enters the reminder system without an explicit human
    confirmation, and a rule that only exists in a disabled button is not a rule —
    anything can POST. `confirmed_by` and `confirmed_at` are NOT NULL in the schema
    for the same reason.
    """
    if not body.scheduleConfirmed:
        return _fail("schedule_not_signed_off")
    if not body.medicines:
        return _fail("no_medicines")

    # FR-2: at most one priority medicine. Enforced rather than trusted.
    if sum(1 for m in body.medicines if m.is_priority) > 1:
        return _fail("multiple_priority_medicines")

    now = db.now_iso()
    con = db.connect()
    try:
        # Re-running onboarding for the same parent updates them rather than
        # colliding on the unique phone index.
        existing = con.execute(
            "SELECT * FROM patients WHERE phone_e164 = ?", (body.parentPhone,)
        ).fetchone()

        if existing:
            patient_id = existing["id"]
            caregiver_id = existing["caregiver_id"]
        else:
            patient_id = str(uuid.uuid4())
            caregiver_row = con.execute(
                "SELECT * FROM caregivers WHERE phone_e164 = ?", (body.phone,)
            ).fetchone()
            caregiver_id = caregiver_row["id"] if caregiver_row else str(uuid.uuid4())

        db.insert(con, "caregivers", {
            "id": caregiver_id,
            # Onboarding never asks the caregiver their own name — it collects a
            # phone and an email and nothing else — so the relationship is the
            # closest true thing we hold. Recorded in SCHEMA-GAPS as a flow gap
            # rather than invented here.
            "name": (body.relation or "Caregiver").strip().title(),
            "phone_e164": body.phone or f"unknown-{caregiver_id[:8]}",
            "email": body.email or None,
            "relationship": body.relation,
            "phone_verified_at": now if body.phoneVerified else None,
            "email_verified_at": now if body.emailVerified else None,
            "created_at": now,
        })

        age = None
        if body.age and str(body.age).strip().isdigit():
            age = int(str(body.age).strip())

        # GAP-2: dose reminders must not be dialled until the intro call is done.
        intro_status = (
            "done" if body.introCall == "now"
            else "pending" if body.introCall == "later"
            else None
        )
        consents = [
            {"id": k, "agreed": v, "agreed_at": now if v else None}
            for k, v in body.consents.items()
        ]

        db.insert(con, "patients", {
            "id": patient_id,
            "caregiver_id": caregiver_id,
            "name": body.parentName,
            "honorific": body.honorific or None,
            "phone_e164": body.parentPhone,
            "language": body.language or "hi-IN",
            "age": age,
            "conditions": body.conditions,
            "allergies": body.allergies,
            "doctor_name": body.doctorName or None,
            "doctor_phone": body.doctorPhone or None,
            "address_text": body.address or None,
            "meal_times": body.mealTimes,
            # This is the FR-4 gate: set only because scheduleConfirmed was true.
            "schedule_signed_off_at": now,
            "calls_paused": 0,
            "intro_call_at": body.introCallAt,
            "intro_call_status": intro_status,
            "consents": consents,
            "created_at": existing["created_at"] if existing else now,
        })

        # Replace the schedule wholesale: this POST represents one signed-off list,
        # and merging it with an older one would produce a schedule nobody signed.
        con.execute("DELETE FROM dose_events WHERE patient_id = ?", (patient_id,))
        con.execute("DELETE FROM medications WHERE patient_id = ?", (patient_id,))

        doc_id = (body.extraction or {}).get("doc_id")
        for med in body.medicines:
            db.insert(con, "medications", {
                "id": str(uuid.uuid4()),
                "patient_id": patient_id,
                "name": med.name,
                "dose": med.dose,
                "slots": med.slots,
                "with_food": med.with_food,
                "is_priority": int(med.is_priority),
                "stock_count": None,
                "duration_days": med.duration_days,
                "end_date": None,
                "source": "prescription" if med.raw_line else "manual",
                "source_doc_id": doc_id,
                "raw_line": med.raw_line,
                "confidence": med.confidence,
                "extraction_flags": med.flags,
                "excluded": int(med.excluded),
                "exclusion_reason": med.exclusion_reason,
                "confirmed_by": caregiver_id,
                "confirmed_at": now,
            })

        con.execute("DELETE FROM escalation_contacts WHERE patient_id = ?", (patient_id,))
        for rank, contact in enumerate(body.escalation, start=1):
            if not contact.name.strip():
                continue
            after = None
            if contact.after and str(contact.after).strip().isdigit():
                after = int(str(contact.after).strip())
            db.insert(con, "escalation_contacts", {
                "id": str(uuid.uuid4()),
                "patient_id": patient_id,
                "name": contact.name,
                "relationship": contact.relationship,
                # GAP-5: onboarding still collects no number for these people, so
                # the ladder remains unusable. Stored anyway rather than dropped.
                "phone_e164": None,
                "after_minutes": after,
                "rank": rank,
            })

        con.commit()
        return {"ok": True, "patient_id": patient_id, "caregiver_id": caregiver_id}
    finally:
        con.close()
