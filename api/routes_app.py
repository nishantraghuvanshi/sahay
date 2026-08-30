"""Caregiver-app endpoints. spec: TRD §5.1, §11

These are the read endpoints `app/src/api/hooks.ts` calls, plus the writes behind
the medicine editor and the dose tick. The onboarding write lives in
api/caregiver/routes.py.

Two conventions the app depends on:

* **Payloads are bare.** `client.ts` does `return body as T`, so a list endpoint
  must return a JSON array and not an envelope around one. Only failures carry
  `{ok: false, error}`, and they come back HTTP 200 because `humanise()` in the
  client turns the error *code* into the sentence a caregiver reads — a raw 404
  would lose that (NFR-6).
* **Every endpoint is caregiver-scoped.** NFR-7 says the browser only ever sees
  caregiver-scoped reads. `CaregiverDep` resolves the session cookie or 401s, and
  `current_patient()` takes that caregiver's id — it is the only place the
  patient is chosen, so there is one place to get the scoping right.

  It used to be `ORDER BY created_at DESC LIMIT 1` with no session at all, which
  meant every signed-in caregiver read the household that onboarded most recently.
  The one exception is `/h/{token}`: a handoff link is given to a paramedic who has
  no account, so the bearer of the token is the authorisation.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from fastapi.responses import JSONResponse

from api import db
from api.auth.deps import CaregiverDep

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


# `SELECT *` on caregivers would put password_hash, password_salt, failed_logins
# and locked_until in a JSON body the browser can read. None of them are in the
# app's `Caregiver` type, so nothing would have noticed the leak.
CAREGIVER_COLUMNS = "id, name, phone_e164, email, relationship, created_at"


def current_patient(con, caregiver_id: str):
    """The signed-in caregiver's patient.

    One per caregiver today — onboarding upserts on the parent's phone and refuses
    a number that belongs to someone else's parent — so LIMIT 1 is the whole set
    rather than a pick from it. `caregiver_id` is not optional on purpose: an
    unscoped read is the bug this replaced, and a default would let it back in.
    """
    return con.execute(
        "SELECT * FROM patients WHERE caregiver_id = ? ORDER BY created_at DESC LIMIT 1",
        (caregiver_id,),
    ).fetchone()


# --------------------------------------------------------------------- reads

@router.get("/app/record")
def get_record(caregiver: CaregiverDep):
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
        if patient is None:
            return _fail("not_found")
        caregiver_row = con.execute(
            f"SELECT {CAREGIVER_COLUMNS} FROM caregivers WHERE id = ?",
            (patient["caregiver_id"],),
        ).fetchone()
        meds = con.execute(
            "SELECT * FROM medications WHERE patient_id = ? AND stopped_at IS NULL "
            "ORDER BY rowid",
            (patient["id"],),
        ).fetchall()
        return {
            "patient": _row("patients", patient),
            "caregiver": _row("caregivers", caregiver_row),
            "medications": [_row("medications", m) for m in meds],
        }
    finally:
        con.close()


@router.get("/app/doses")
def get_doses(caregiver: CaregiverDep):
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
        if patient is None:
            return []
        rows = con.execute(
            "SELECT * FROM dose_events WHERE patient_id = ? ORDER BY slot_time", (patient["id"],)
        ).fetchall()
        return [_row("dose_events", r) for r in rows]
    finally:
        con.close()


@router.get("/app/observations")
def get_observations(caregiver: CaregiverDep):
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
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
def get_escalations(caregiver: CaregiverDep):
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
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
def get_calls(caregiver: CaregiverDep):
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
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
def get_intake(record_id: str, caregiver: CaregiverDep):
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
        if patient is None:
            return _fail("not_found")
        # `AND patient_id = ?` rather than a fetch-then-compare: one query cannot
        # drift out of step with the check that follows it, and "belongs to someone
        # else" and "does not exist" collapse into the same answer, which is what
        # we want to tell the caller anyway.
        row = con.execute(
            "SELECT * FROM intake_records WHERE id = ? AND patient_id = ?",
            (record_id, patient["id"]),
        ).fetchone()
        if row is None:
            return _fail("not_found")
        return _row("intake_records", row)
    finally:
        con.close()


@router.get("/app/summary")
def get_summary(caregiver: CaregiverDep):
    """Today's roll-up. Derived on read, never stored (wireframe 1f).

    Mirrors the derivation in app/src/api/mock.ts so the live screen and the mock
    screen cannot disagree about what "today so far" means.
    """
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
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
        ).fetchone()
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
#
# Onboarding is NOT here. There used to be a second `POST /app/onboarding` in this
# file, and because this router is included before api/caregiver/routes.py — whose
# router carries the `/app` prefix — Starlette matched this one on every request
# and the authenticated version was unreachable. This one took camelCase
# (`parentName`, `scheduleConfirmed`) while the app sends snake_case, so every real
# onboarding answered 422 and no patient was ever written. The surviving endpoint
# is api/caregiver/routes.py::onboarding, which authenticates.

class MedicationEdit(BaseModel):
    """One row as the medicine editor holds it (app/src/screens/MedicinesEdit.tsx)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    dose: str
    slots: list[str] = Field(default_factory=list)
    with_food: str | None = "any"
    is_priority: bool = False
    stopped: bool = False
    isNew: bool = False


class MedicationChange(BaseModel):
    model_config = ConfigDict(extra="ignore")

    medications: list[MedicationEdit] = Field(default_factory=list)
    diff: list[str] = Field(default_factory=list)
    consent_text: str = ""
    consent_ack: bool = False


@router.post("/app/medications")
def post_medications(body: MedicationChange, caregiver: CaregiverDep):
    """Persist an edited schedule, with the attestation that justified it.

    The doctor-advice attestation is the reason this endpoint exists at all, so it
    is checked here and not only in the UI. It is stored as the **text** the
    caregiver actually read, alongside who changed what — an attestation you cannot
    reproduce is not evidence, and a boolean against nothing is not an audit trail
    (SCHEMA-GAPS §3).

    Edits update in place rather than replacing the set, because the provenance
    columns — `raw_line`, `confidence`, `source_doc_id` — belong to the reading the
    row came from and the editor never sees them. Replacing wholesale would quietly
    destroy the evidence for every medicine the caregiver did not touch.

    Stopping is a soft `stopped_at`, not a delete: `dose_events` reference these rows
    and a stopped medicine's history is still the record of what was taken.
    """
    if not body.consent_ack or not body.consent_text.strip():
        return _fail("attestation_required")
    if sum(1 for m in body.medications if m.is_priority and not m.stopped) > 1:
        return _fail("multiple_priority_medicines")

    live = [m for m in body.medications if not m.stopped]
    if any(not m.name.strip() or not m.dose.strip() or not m.slots for m in live):
        return _fail("incomplete_medicine")

    now = db.now_iso()
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
        if patient is None:
            return _fail("not_found")
        pid = patient["id"]

        known = {
            r["id"] for r in con.execute("SELECT id FROM medications WHERE patient_id = ?", (pid,))
        }

        for med in body.medications:
            if med.stopped:
                if med.id in known:
                    con.execute(
                        "UPDATE medications SET stopped_at = ? WHERE id = ? AND patient_id = ?",
                        (now, med.id, pid),
                    )
                continue

            if med.id in known:
                con.execute(
                    "UPDATE medications SET name = ?, dose = ?, slots = ?, with_food = ?, "
                    "is_priority = ?, stopped_at = NULL WHERE id = ? AND patient_id = ?",
                    (med.name, med.dose, json.dumps(med.slots), med.with_food,
                     int(med.is_priority), med.id, pid),
                )
            else:
                # Typed on this screen, so it was not read off a prescription.
                db.insert(con, "medications", {
                    "id": med.id if med.isNew else str(uuid.uuid4()),
                    "patient_id": pid,
                    "name": med.name,
                    "dose": med.dose,
                    "slots": med.slots,
                    "with_food": med.with_food,
                    "is_priority": int(med.is_priority),
                    "stock_count": None,
                    "start_date": now,
                    "source": "manual",
                    "extraction_flags": [],
                    "excluded": 0,
                    "confirmed_by": patient["caregiver_id"],
                    "confirmed_at": now,
                })

        db.insert(con, "medication_changes", {
            "id": str(uuid.uuid4()),
            "patient_id": pid,
            "changed_at": now,
            "changed_by": patient["caregiver_id"],
            "diff": body.diff,
            "consent_text": body.consent_text,
            "consent_ack": int(body.consent_ack),
        })
        con.commit()
        return {"ok": True, "changed": len(body.diff)}
    finally:
        con.close()


class DoseMark(BaseModel):
    model_config = ConfigDict(extra="ignore")

    medication_id: str
    slot_time: str
    status: str = "confirmed"
    note: str | None = None
    # 'agent' | 'caregiver' | 'patient'. A dose the caregiver ticked in the app and
    # one the patient confirmed on a call are different facts.
    actor: str = "caregiver"


@router.post("/app/doses")
def post_dose(body: DoseMark, caregiver: CaregiverDep):
    """Record a dose the caregiver confirmed themselves.

    Writing the event is what cancels the agent's call for that slot: the scheduler
    only dials slots with no `dose_events` row, so this is the cancellation rather
    than a separate flag to keep in step with it.

    `INSERT OR REPLACE` against the unique `(medication_id, slot_time)` index makes a
    double tap — or a retried request — land on the same row instead of logging the
    dose twice (TRD §3.1).
    """
    if body.status not in {"pending", "confirmed", "deferred", "missed", "no_answer", "unknown"}:
        return _fail("bad_status")

    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
        if patient is None:
            return _fail("not_found")
        med = con.execute(
            "SELECT id FROM medications WHERE id = ? AND patient_id = ?",
            (body.medication_id, patient["id"]),
        ).fetchone()
        if med is None:
            return _fail("not_found")

        # Whole row, not just the id: the retry counters below are read off it.
        existing = con.execute(
            "SELECT * FROM dose_events WHERE medication_id = ? AND slot_time = ?",
            (body.medication_id, body.slot_time),
        ).fetchone()

        db.insert(con, "dose_events", {
            "id": existing["id"] if existing else str(uuid.uuid4()),
            "patient_id": patient["id"],
            "medication_id": body.medication_id,
            "slot_time": body.slot_time,
            "call_session_id": None,
            "status": body.status,
            "note": body.note,
            "actor": body.actor,
            # Preserved across an update: the scheduler owns these, and a caregiver
            # confirming a dose must not erase the record of how many times we rang.
            "attempt_count": existing["attempt_count"] if existing else 0,
            "next_attempt_at": existing["next_attempt_at"] if existing else None,
            "created_at": db.now_iso(),
        })
        con.commit()
        return {"ok": True}
    finally:
        con.close()


class DoseMove(BaseModel):
    model_config = ConfigDict(extra="ignore")

    medication_id: str
    from_slot_time: str
    to_slot_time: str


@router.post("/app/doses/move")
def post_dose_move(body: DoseMove, caregiver: CaregiverDep):
    """Move a single occurrence of a dose, leaving the recurring schedule alone.

    `medications.slots` are recurring local times, so there is nowhere in that row to
    say "just Tuesday's 08:30 goes to 10:00". The occurrence is recorded instead as a
    `dose_events` row keyed on its original `slot_time`, with status `deferred` — which
    already means "put off to a later time, and still expected" — and the new time in
    `rescheduled_to`.

    Keying on the original slot is what makes this idempotent and reversible: moving
    the same occurrence twice updates one row rather than accumulating them, and the
    slot it came from is still recoverable.

    Refused once the dose has been answered. A confirmed dose cannot be moved — it has
    already been taken — and silently rewriting one would falsify the record.
    """
    con = db.connect()
    try:
        patient = current_patient(con, caregiver.id)
        if patient is None:
            return _fail("not_found")
        med = con.execute(
            "SELECT id FROM medications WHERE id = ? AND patient_id = ? AND stopped_at IS NULL",
            (body.medication_id, patient["id"]),
        ).fetchone()
        if med is None:
            return _fail("not_found")

        existing = con.execute(
            "SELECT * FROM dose_events WHERE medication_id = ? AND slot_time = ?",
            (body.medication_id, body.from_slot_time),
        ).fetchone()
        if existing and existing["status"] not in ("deferred",):
            return _fail("dose_already_answered")

        db.insert(con, "dose_events", {
            "id": existing["id"] if existing else str(uuid.uuid4()),
            "patient_id": patient["id"],
            "medication_id": body.medication_id,
            "slot_time": body.from_slot_time,
            "rescheduled_to": body.to_slot_time,
            "call_session_id": None,
            "status": "deferred",
            "note": "Moved by the caregiver in the app.",
            "actor": "caregiver",
            "attempt_count": existing["attempt_count"] if existing else 0,
            "next_attempt_at": existing["next_attempt_at"] if existing else None,
            "created_at": db.now_iso(),
        })
        con.commit()
        return {"ok": True}
    finally:
        con.close()
