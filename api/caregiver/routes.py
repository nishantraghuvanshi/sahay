"""spec: FR-1 · FR-4 — the caregiver app's own surface.

`/app/*` is not in the TRD. It exists because the browser cannot hold
CARE_API_TOKEN (NFR-7), so the app needs caregiver-scoped endpoints that
authenticate by session instead — see docs/SCHEMA-GAPS-LANE-C.md.

Only the onboarding write lives here. The read endpoints the app polls
(`/app/record`, `/app/doses`, ...) are in api/routes_app.py and take the same
`CaregiverDep`, so the whole `/app` surface is scoped by the session cookie.
"""

from __future__ import annotations

import json
import logging
import uuid

import httpx
from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import BaseModel, Field

from api import db
from api.auth.deps import CaregiverDep, SettingsDep

log = logging.getLogger("kinvox.caregiver")

router = APIRouter(prefix="/app", tags=["caregiver app"])


class DraftMedicine(BaseModel):
    name: str
    dose: str
    slots: list[str] = Field(default_factory=list)
    with_food: str | None = None
    is_priority: bool = False

    # Provenance. Safety rule S3 requires the verbatim line the model read to
    # survive to a reviewer, so it is carried through the boundary rather than
    # dropped here — the schedule screen shows it, and until now nothing stored it.
    raw_line: str | None = None
    confidence: float | None = None
    flags: list[str] = Field(default_factory=list)
    duration_days: int | None = None
    excluded: bool = False
    exclusion_reason: str | None = None


class EscalationContact(BaseModel):
    """Who to ring after the caregiver. Collected nowhere in the app yet, so this
    arrives empty — stored rather than dropped so the flow that fills it in has
    somewhere to land (SCHEMA-GAPS §5)."""

    name: str = ""
    relationship: str | None = None
    after: int | None = None


class OnboardingBody(BaseModel):
    """Mirrors SetupDraft in app/src/setup/store.ts, minus the UI-only flags."""

    caregiver_name: str = ""
    relation: str = ""

    parent_name: str
    honorific: str | None = None
    parent_phone: str
    language: str = "hi-IN"
    age: int | None = None
    conditions: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    doctor_name: str | None = None
    doctor_phone: str | None = None
    address: str | None = None
    meal_times: dict[str, str] = Field(default_factory=dict)

    medicines: list[DraftMedicine] = Field(default_factory=list)
    consents: dict[str, bool] = Field(default_factory=dict)

    # FR-4 / design doc S1. The schedule screen disables its button until the
    # caregiver signs off, but a disabled button is not a rule — anything can POST.
    schedule_confirmed: bool = False

    # The reading these medicines came from, so a row can be traced back to a
    # document rather than only to its own raw_line.
    extraction: dict | None = None

    # GAP-2: the scheduler must not dial a dose slot until the intro call is done,
    # or the product calls a parent who never agreed to be called. The consent
    # screen already asks; this is where the answer becomes a column.
    intro_call: str | None = None          # 'now' | 'later'
    intro_call_at: str | None = None

    escalation: list[EscalationContact] = Field(default_factory=list)



REQUIRED_CONSENTS = ("informed", "recording", "no_advice")


@router.post("/onboarding")
async def onboarding(body: OnboardingBody, caregiver: CaregiverDep):
    """Turn the localStorage draft into rows.

    FR-4: `schedule_signed_off_at` is stamped here and nowhere else. It is the
    gate the scheduler reads before placing any call, so it is set only once all
    three consents are actually present — a client that forgets one must not be
    able to start the calling.

    One transaction: a patient with half a prescription is worse than no patient.
    """
    # Checked before the consents: an unsigned schedule is not a thing to consent
    # to, and it is the gate the whole dialler hangs off.
    if not body.schedule_confirmed:
        return {"ok": False, "error": "schedule_not_signed_off"}

    missing = [c for c in REQUIRED_CONSENTS if not body.consents.get(c)]
    if missing:
        return {"ok": False, "error": "consent_missing"}

    if not body.medicines:
        return {"ok": False, "error": "no_medicines"}

    priority_count = sum(1 for m in body.medicines if m.is_priority)
    if priority_count > 1:
        # medications has a partial unique index enforcing this; catching it here
        # gives the app a named error instead of a constraint violation.
        return {"ok": False, "error": "multiple_priority"}

    now = datetime.now(UTC).isoformat()

    async with db.transaction() as conn:
        # The caregiver row was created by the phone OTP with an empty name;
        # screen 1b is where it finally gets one.
        await conn.execute(
            "UPDATE caregivers SET name = COALESCE(NULLIF($2, ''), name), "
            "relationship = COALESCE(NULLIF($3, ''), relationship) WHERE id = $1",
            caregiver.id,
            body.caregiver_name.strip(),
            body.relation.strip(),
        )

        # Re-running onboarding for the same parent updates rather than colliding
        # on the unique phone index — the caregiver may have gone back a screen.
        # GAP-2: 'now' means the intro call happens immediately, 'later' means it
        # is booked and has NOT happened. The dialler refuses dose slots until this
        # reads 'done', so mapping 'later' to anything else would start calling a
        # parent who has not yet been introduced to the thing calling them.
        intro_status = (
            "done" if body.intro_call == "now"
            else "pending" if body.intro_call == "later"
            else None
        )
        # Stored WITH the moment they were given. A bare boolean against nothing is
        # not evidence (api/schema.sql, `consents`).
        consents = [
            {"id": k, "agreed": bool(v), "agreed_at": now if v else None}
            for k, v in body.consents.items()
        ]

        patient_id = await conn.fetchval(
            """
            INSERT INTO patients (
                id, caregiver_id, name, honorific, phone_e164, language, age,
                conditions, allergies, doctor_name, doctor_phone, address_text,
                meal_times, schedule_signed_off_at,
                intro_call_at, intro_call_status, consents, created_at
            ) VALUES ($13,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$14,
                      $15,$16,$17,$14)
            ON CONFLICT (phone_e164) DO UPDATE SET
                name = EXCLUDED.name, honorific = EXCLUDED.honorific,
                language = EXCLUDED.language, age = EXCLUDED.age,
                conditions = EXCLUDED.conditions, allergies = EXCLUDED.allergies,
                doctor_name = EXCLUDED.doctor_name, doctor_phone = EXCLUDED.doctor_phone,
                address_text = EXCLUDED.address_text, meal_times = EXCLUDED.meal_times,
                schedule_signed_off_at = $14,
                intro_call_at = EXCLUDED.intro_call_at,
                intro_call_status = EXCLUDED.intro_call_status,
                consents = EXCLUDED.consents
            WHERE patients.caregiver_id = $1
            RETURNING id
            """,
            caregiver.id,
            body.parent_name.strip(),
            (body.honorific or "").strip() or None,
            body.parent_phone.strip(),
            body.language,
            body.age,
            # conditions/allergies are TEXT[] upstream and JSON text here, in
            # line with the substitutions api/schema.sql documents. db.decode()
            # is what parses them back on the way out.
            json.dumps(body.conditions or []),
            json.dumps(body.allergies or []),
            body.doctor_name,
            body.doctor_phone,
            body.address,
            json.dumps(body.meal_times),
            # id and the sign-off timestamp are supplied: no gen_random_uuid()
            # or now() here, and a TEXT primary key accepts NULL in silence.
            # `created_at` is NOT NULL and has no DEFAULT, so omitting it — as this
            # statement did — made every first onboarding an IntegrityError. It
            # reuses $14 because on a re-run the ON CONFLICT branch never touches it.
            str(uuid.uuid4()),
            now,
            body.intro_call_at,
            intro_status,
            json.dumps(consents),
        )
        if patient_id is None:
            # The ON CONFLICT WHERE clause filtered the update out: this phone
            # belongs to a different caregiver's parent.
            return {"ok": False, "error": "patient_phone_taken"}

        # Replace rather than merge. The schedule the caregiver just signed off
        # is the whole truth; a medicine they deleted must not survive.
        #
        # dose_events reference medications, so they go first — otherwise the
        # DELETE below trips the foreign key on a re-run. Dropping them is correct
        # here and only here: this is a schedule being signed off for the first
        # time, so any events against the old rows were never real outcomes. The
        # medicine *editor* (routes_app.py) must never do this, which is why it
        # updates in place and stops medicines softly.
        await conn.execute("DELETE FROM dose_events WHERE patient_id = $1", patient_id)
        await conn.execute("DELETE FROM medications WHERE patient_id = $1", patient_id)

        doc_id = (body.extraction or {}).get("doc_id")
        for m in body.medicines:
            await conn.execute(
                """
                INSERT INTO medications (
                    id, patient_id, name, dose, slots, with_food, is_priority,
                    duration_days, start_date, source, source_doc_id, raw_line,
                    confidence, extraction_flags, excluded, exclusion_reason,
                    confirmed_by, confirmed_at, created_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
                """,
                # Supplied, not defaulted. SQLite lets a TEXT PRIMARY KEY hold NULL
                # and treats NULLs as distinct, so omitting this inserted a whole
                # schedule of rows with no id — which the app keys its list on and
                # dose_events point at.
                str(uuid.uuid4()),
                patient_id,
                m.name,
                m.dose,
                # slots is TEXT holding a JSON array. Binding the Python list
                # directly raises InterfaceError; sqlite3 has no list adapter.
                json.dumps(m.slots),
                m.with_food,
                int(m.is_priority),
                m.duration_days,
                # The course starts when the caregiver signed it off. There is no
                # earlier date on the prescription we could trust.
                now,
                "prescription" if m.raw_line else "manual",
                doc_id,
                m.raw_line,
                m.confidence,
                json.dumps(m.flags or []),
                int(m.excluded),
                m.exclusion_reason,
                # This POST *is* the sign-off, so the row carries who signed it.
                caregiver.id,
                now,
            )

        # Rank order is the ladder order, so it comes from the list position.
        await conn.execute("DELETE FROM escalation_contacts WHERE patient_id = $1", patient_id)
        rank = 0
        for contact in body.escalation:
            if not contact.name.strip():
                continue
            rank += 1
            await conn.execute(
                "INSERT INTO escalation_contacts "
                "(id, patient_id, name, relationship, phone_e164, after_minutes, rank) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                str(uuid.uuid4()),
                patient_id,
                contact.name.strip(),
                contact.relationship,
                # GAP-5: onboarding still collects no number for these people, so
                # the ladder remains unusable. Stored anyway rather than dropped.
                None,
                contact.after,
                rank,
            )

    return {"ok": True, "patient_id": str(patient_id)}


# ------------------------------------------------------------------ demo call


class DemoCallBody(BaseModel):
    persona: str = "forgot"


@router.get("/demo-call")
async def demo_call_status(caregiver: CaregiverDep):
    """Whether this caregiver still has their one demo call.

    A GET so the button can render its real state on load instead of finding
    out by being pressed.
    """
    async with db.connection() as conn:
        used_at = await conn.fetchval(
            "SELECT demo_call_used_at FROM caregivers WHERE id = $1", caregiver.id
        )
        patient = await conn.fetchrow(
            "SELECT name, phone_e164 FROM patients WHERE caregiver_id = $1 LIMIT 1",
            caregiver.id,
        )
    return {
        "ok": True,
        "available": used_at is None,
        "used_at": used_at,
        # No patient means onboarding is not finished, and a demo would have no
        # name or medicine to speak.
        "ready": patient is not None,
    }


@router.post("/demo-call")
async def demo_call(body: DemoCallBody, caregiver: CaregiverDep, settings: SettingsDep):
    """Run one demo dose call and return the transcript.

    Nobody's phone rings. The agent runs the real prompt against a scripted
    patient through ElevenLabs' simulate-conversation endpoint and hands back
    text — which is the point: a caregiver can read exactly how this thing
    talks to their parent before it ever does.

    Deliberately cannot affect anything. Tool calls are mocked upstream, so the
    demo cannot mark a dose taken, cannot raise a family alert, and writes no
    call record. The only thing it changes is that this caregiver has now used
    their one demo.

    The API does not talk to ElevenLabs itself. The agent owns that integration,
    the prompt and the dose schedule; a demo that went around it would be
    demonstrating something other than what actually calls the patient.
    """
    async with db.transaction() as conn:
        used_at = await conn.fetchval(
            "SELECT demo_call_used_at FROM caregivers WHERE id = $1", caregiver.id
        )
        if used_at is not None:
            return {"ok": False, "error": "demo_already_used", "used_at": used_at}

        patient = await conn.fetchrow(
            "SELECT name, phone_e164, drug_name FROM patients WHERE caregiver_id = $1 LIMIT 1",
            caregiver.id,
        )
        if patient is None:
            return {"ok": False, "error": "onboarding_incomplete"}

        med = await conn.fetchval(
            "SELECT name FROM medications WHERE patient_id = "
            "(SELECT id FROM patients WHERE caregiver_id = $1 LIMIT 1) "
            "AND excluded = 0 AND stopped_at IS NULL LIMIT 1",
            caregiver.id,
        )

        # Claimed BEFORE the call, inside the transaction. Claiming afterwards
        # would let two clicks in flight at once both pass the check and spend
        # two demos, and would also hand a free retry to anyone whose demo
        # happened to fail — which is the same hole from the other side.
        await conn.execute(
            "UPDATE caregivers SET demo_call_used_at = $2 WHERE id = $1",
            caregiver.id,
            _now_iso(),
        )

    drug = med or patient["drug_name"] or "your medicine"
    try:
        async with httpx.AsyncClient(timeout=settings.demo_call_timeout_s) as client:
            headers = {"x-api-key": settings.agent_api_key} if settings.agent_api_key else {}
            resp = await client.post(
                f"{settings.agent_base_url.rstrip('/')}/api/demo-call",
                headers=headers,
                json={
                    "phone": patient["phone_e164"],
                    "name": patient["name"] or "आपके",
                    "drug": drug,
                    "caregiver": caregiver.name,
                    "persona": body.persona,
                },
            )
    except httpx.HTTPError as exc:
        await _release_demo(caregiver.id)
        log.warning("demo call could not reach the agent: %s", exc)
        return {"ok": False, "error": "agent_unreachable"}

    if resp.status_code != 200:
        # The agent refused or broke. Give the demo back rather than charging
        # a caregiver their single attempt for our outage.
        await _release_demo(caregiver.id)
        log.warning("demo call rejected by agent: %s %s", resp.status_code, resp.text[:200])
        return {"ok": False, "error": "demo_failed", "status": resp.status_code}

    return {"ok": True, **resp.json()}


async def _release_demo(caregiver_id: str) -> None:
    """Hand the demo back after a failure that was ours, not the caregiver's."""
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE caregivers SET demo_call_used_at = NULL WHERE id = $1", caregiver_id
        )


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
