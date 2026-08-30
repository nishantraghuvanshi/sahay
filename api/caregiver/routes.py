"""spec: FR-1 · FR-4 — the caregiver app's own surface.

`/app/*` is not in the TRD. It exists because the browser cannot hold
CARE_API_TOKEN (NFR-7), so the app needs caregiver-scoped endpoints that
authenticate by session instead — see docs/SCHEMA-GAPS-LANE-C.md.

Only the onboarding write lives here. The eight read endpoints the app polls
(`/app/record`, `/app/doses`, ...) are still mocked client-side and belong to
Lane B.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import BaseModel, Field

from api import db
from api.auth.deps import CaregiverDep

router = APIRouter(prefix="/app", tags=["caregiver app"])


class DraftMedicine(BaseModel):
    name: str
    dose: str
    slots: list[str] = Field(default_factory=list)
    with_food: str | None = None
    is_priority: bool = False


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
        patient_id = await conn.fetchval(
            """
            INSERT INTO patients (
                id, caregiver_id, name, honorific, phone_e164, language, age,
                conditions, allergies, doctor_name, doctor_phone, address_text,
                meal_times, schedule_signed_off_at
            ) VALUES ($13,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$14)
            ON CONFLICT (phone_e164) DO UPDATE SET
                name = EXCLUDED.name, honorific = EXCLUDED.honorific,
                language = EXCLUDED.language, age = EXCLUDED.age,
                conditions = EXCLUDED.conditions, allergies = EXCLUDED.allergies,
                doctor_name = EXCLUDED.doctor_name, doctor_phone = EXCLUDED.doctor_phone,
                address_text = EXCLUDED.address_text, meal_times = EXCLUDED.meal_times,
                schedule_signed_off_at = $14
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
            str(uuid.uuid4()),
            datetime.now(UTC).isoformat(),
        )
        if patient_id is None:
            # The ON CONFLICT WHERE clause filtered the update out: this phone
            # belongs to a different caregiver's parent.
            return {"ok": False, "error": "patient_phone_taken"}

        # Replace rather than merge. The schedule the caregiver just signed off
        # is the whole truth; a medicine they deleted must not survive.
        await conn.execute("DELETE FROM medications WHERE patient_id = $1", patient_id)
        for m in body.medicines:
            await conn.execute(
                "INSERT INTO medications (patient_id, name, dose, slots, with_food, is_priority) "
                "VALUES ($1,$2,$3,$4,$5,$6)",
                patient_id,
                m.name,
                m.dose,
                m.slots,
                m.with_food,
                m.is_priority,
            )

    return {"ok": True, "patient_id": str(patient_id)}
