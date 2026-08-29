"""ExtractionDocument -> the schedule shape the caregiver app can render.

This module does not exist upstream. The handoff is explicit that `normalize.py`
and `validate.py` are unbuilt, and the app cannot consume a raw ExtractionDocument
without them: the pipeline emits abstract slots (`["morning", "night"]`) while
`DraftMedicine.slots` in app/src/setup/store.ts needs local clock times
(`["08:30", "21:00"]`).

Two jobs, kept together because the validation outcome decides what the caregiver
is shown:

1. **Expand** abstract slots to clock times, anchored on the caregiver's own meal
   times, and flatten brand/generic/strength into the app's `name` + `dose`.
2. **Validate** against design doc §7. A failing rule sets a flag; it never drops
   or silently corrects a medicine (S5).

What this module deliberately does NOT do:

- It never invents a value. A field the model returned as null stays null and the
  row is marked `unclear`, which is what forces the caregiver to touch it — the
  app's sign-off button is disabled while any row is unclear (S2).
- It never decides a schedule is safe. Everything here is still pre-confirmation;
  `needs_review=False` means "fewer things for the reviewer to look at", not
  "skip the reviewer" (S1).
- It does not collapse doses within a 45-minute window into one call (design doc
  §5.2). That is a scheduler concern and belongs downstream of confirmation.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field

from .schema import ExtractionDocument, Flag, FoodRelation, Form, MedicineExtraction, ScheduleSlot

# A flag this module raises that is not in the vendored `Flag` enum, because it
# describes a normalization outcome rather than something the extractor reported.
# Kept out of the enum so the vendored schema stays byte-identical to upstream.
STRENGTH_UNKNOWN = "strength_unknown"

# A dose that is just a number — "1", "2", "½", "1/2" — with no unit attached.
_BARE_COUNT = re.compile(r"^(?:\d+(?:[.,]\d+)?|[½¼¾]|\d+\s*/\s*\d+)$")

# Design doc §7: confidence below this is flagged for review regardless of how
# well-formed the rest of the row looks. A confident wrong answer is the failure
# mode this whole module guards against, so the bar is deliberately not low.
MIN_CONFIDENCE = 0.70

# Design doc §7: a duration outside this range is a misread, not a prescription.
MIN_DURATION_DAYS = 1
MAX_DURATION_DAYS = 90

# Design doc §7: more than four dosing slots a day is a misparse of the notation.
MAX_SCHEDULE_SLOTS = 4

# Design doc §3.3 / safety rule 4: a phone call telling someone to take an
# injection is not useful, and reading out an ointment schedule is noise.
NON_ORAL_FORMS = {Form.injection, Form.ointment, Form.drops}

# Design doc §5.2. Used only when the caregiver has not given us their real meal
# times; the anchors below are what the app collects on the parent screen (1b).
DEFAULT_MEAL_TIMES = {"breakfast": "08:00", "lunch": "14:00", "dinner": "20:00"}

SLOT_ANCHOR = {
    ScheduleSlot.morning: "breakfast",
    ScheduleSlot.afternoon: "lunch",
    ScheduleSlot.night: "dinner",
}

# Design doc §5.2 — minutes relative to the meal.
FOOD_OFFSET_MIN = {FoodRelation.before: -30, FoodRelation.after: 30, None: 0}


class NormalizedMedicine(BaseModel):
    """One row as the review screen will show it.

    The first six fields mirror `DraftMedicine` in app/src/setup/store.ts. The rest
    is review provenance the app has nowhere to store yet (see
    docs/SCHEMA-GAPS-LANE-C.md) but which safety rules S3 and S6 require a reviewer
    to see: `raw_line` is what the model claims it read, and it has to survive all
    the way to the screen or the caregiver is confirming a value they cannot check.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    dose: str
    slots: list[str] = Field(default_factory=list)
    with_food: str  # 'before' | 'after' | 'any' — app/src/api/types.ts WithFood
    is_priority: bool = False
    unclear: bool

    raw_line: str
    confidence: float
    """Validation flags. Plain strings rather than the vendored `Flag` enum,
    because this module raises `strength_unknown`, which is a normalization
    outcome and deliberately not part of upstream's schema."""
    flags: list[str] = Field(default_factory=list)
    duration_days: int | None = None

    # Extracted, shown, but never scheduled. Excluded rows are surfaced rather
    # than filtered out: dropping them silently would mean the caregiver never
    # learns the SOS medicine on the page was read at all.
    excluded: bool = False
    exclusion_reason: str | None = None


class NormalizedSchedule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    doc_id: str
    model: str
    medicines: list[NormalizedMedicine] = Field(default_factory=list)
    unparsed_lines: list[str] = Field(default_factory=list)
    needs_review: bool
    review_reasons: list[str] = Field(default_factory=list)


def _shift(hhmm: str, minutes: int) -> str:
    """Offset a local 'HH:MM' by minutes, wrapping within the day.

    Built on timedelta rather than integer arithmetic so 23:45 + 30 lands on
    00:15 instead of an unrenderable '24:15'.
    """
    base = datetime.strptime(hhmm, "%H:%M")
    return (base + timedelta(minutes=minutes)).strftime("%H:%M")


def _meal_times(overrides: dict[str, str] | None) -> dict[str, str]:
    """Caregiver meal times where given, documented defaults elsewhere.

    Each value is validated by parsing it; a malformed entry falls back to the
    default for that meal rather than propagating a string the app cannot render
    as a time.
    """
    times = dict(DEFAULT_MEAL_TIMES)
    for meal, value in (overrides or {}).items():
        if meal not in times or not isinstance(value, str):
            continue
        try:
            datetime.strptime(value, "%H:%M")
        except ValueError:
            continue
        times[meal] = value
    return times


def _expand_slots(
    schedule: list[ScheduleSlot], food: FoodRelation | None, meals: dict[str, str]
) -> list[str]:
    """Abstract slots -> sorted local clock times, offset by the food relation."""
    offset = FOOD_OFFSET_MIN.get(food, 0)
    times = {_shift(meals[SLOT_ANCHOR[slot]], offset) for slot in schedule if slot in SLOT_ANCHOR}
    return sorted(times)


def _name_of(med: MedicineExtraction) -> str:
    """The app has one name field; the pipeline has brand and generic.

    Brand leads because that is how Indian prescriptions are written (design doc
    §3.4) and how the patient will recognise the medicine on a phone call. Neither
    is invented — if the model read no name, this returns empty and the row is
    marked unclear rather than being labelled from raw_line, which would put
    unvalidated OCR text into a field the caregiver reads as confirmed.
    """
    return (med.brand or med.generic or "").strip()


def _dose_of(med: MedicineExtraction) -> tuple[str, bool]:
    """Returns (dose, strength_unknown).

    Strength for unit doses ('650mg'), dose_amount for the rest ('2 tsp').

    The second return value guards a failure observed live on real output: where
    the prescription line carries no written strength, the model tends to report
    `dose_amount: "1"` — read off the leading digit of the `1-0-1` positional
    notation, not off anything the doctor wrote — and does so at 0.95 confidence
    with no flag of its own. A bare unitless count with no strength anywhere on
    the row is therefore treated as *strength not known*: the field is blanked and
    the row goes to review, rather than showing a caregiver "Zerodol-SP · 1" as
    though the dose had been read off the paper (design doc §2, S2).

    A dose_amount that carries a unit — "2 tsp", "10 ml", "2 puffs" — is a real
    reading and is kept.
    """
    if med.strength and med.strength.strip():
        return med.strength.strip(), False

    amount = (med.dose_amount or "").strip()
    if amount and _BARE_COUNT.match(amount):
        return "", True
    return amount, False


def _validate(med: MedicineExtraction) -> list[Flag]:
    """Design doc §7, minus the two rules that need data we do not have here.

    `unknown_brand` and `strength_not_in_formulary` are not evaluated: the seed
    formulary at upstream data/formulary/ is not wired up, and emitting those
    flags from an empty table would mark every medicine unknown, training the
    caregiver to ignore the flag that matters. `pipeline_disagreement` needs
    Pipeline A's OCR rows, which we do not run.
    """
    flags: list[Flag] = []

    if med.confidence < MIN_CONFIDENCE:
        flags.append(Flag.low_confidence)

    if med.duration_days is not None and not (
        MIN_DURATION_DAYS <= med.duration_days <= MAX_DURATION_DAYS
    ):
        flags.append(Flag.implausible_duration)

    # A PRN medicine legitimately has no schedule; anything else needs at least
    # one slot and no more than four.
    if not med.prn and not 1 <= len(med.schedule) <= MAX_SCHEDULE_SLOTS:
        flags.append(Flag.implausible_schedule)

    if med.form in NON_ORAL_FORMS:
        flags.append(Flag.exclude_from_calls)

    return flags


def _exclusion(med: MedicineExtraction) -> str | None:
    """Why this medicine gets no reminder, or None if it should be scheduled."""
    if med.prn:
        # Safety rule 4: an as-needed medicine has no fixed time to call about,
        # and calling anyway teaches the patient to ignore the calls.
        return "Taken as needed (SOS) — no reminder is scheduled."
    if med.form in NON_ORAL_FORMS:
        return f"{med.form.value.capitalize()} — not something to remind by phone call."
    return None


def normalize_medicine(
    med: MedicineExtraction, meals: dict[str, str], doc_id: str
) -> NormalizedMedicine:
    flags: list[str] = [f.value for f in _validate(med)]
    reason = _exclusion(med)
    name = _name_of(med)
    dose, strength_unknown = _dose_of(med)
    if strength_unknown:
        flags.append(STRENGTH_UNKNOWN)

    slots = [] if reason else _expand_slots(med.schedule, med.food, meals)

    # `unclear` is what the app's sign-off gate reads: Schedule.tsx refuses to
    # enable the confirm button while any row is unclear. It means one specific
    # thing — "a human must correct this before it can be scheduled" — so it is
    # true for anything the caregiver has to check against the photo: a flag
    # fired, or a field the model abstained on.
    #
    # An excluded row is never unclear, because nothing will be scheduled from
    # it. Its flags still show, so a low-confidence SOS row is visible; it just
    # does not hold the whole sign-off hostage. Blocking confirmation on a row
    # that can never generate a call is how caregivers learn to tick past the
    # gate, which would cost far more than the row is worth.
    if reason:
        unclear = False
    else:
        missing = not name or not dose
        unclear = bool(flags) or missing or not slots

    return NormalizedMedicine(
        id=f"{doc_id}-{med.index}",
        name=name,
        dose=dose,
        slots=slots,
        with_food=med.food.value if med.food else "any",
        is_priority=False,  # FR-2: exclusive, and the caregiver's choice to make
        unclear=unclear,
        raw_line=med.raw_line,
        confidence=med.confidence,
        flags=flags,
        duration_days=med.duration_days,
        excluded=reason is not None,
        exclusion_reason=reason,
    )


def normalize(
    doc: ExtractionDocument, meal_times: dict[str, str] | None = None
) -> NormalizedSchedule:
    """Turn an ExtractionDocument into the app's schedule shape.

    `meal_times` is the caregiver's `{breakfast, lunch, dinner}` from the parent
    screen. Anchoring on their real routine beats the design doc's fixed
    08:00/14:00/20:00: a call timed to when the patient actually eats is the
    difference between a useful reminder and one that arrives an hour early.

    The document's own `needs_review` and `review_reasons` are preserved and
    extended, never replaced — `no_medicines_parsed` and a truncated
    `vlm_finish_reason` mean medicines may be missing from the page entirely, and
    that cannot be inferred from the rows that did parse.
    """
    meals = _meal_times(meal_times)
    medicines = [normalize_medicine(m, meals, doc.doc_id) for m in doc.medicines]

    reasons = list(doc.review_reasons)
    if any(m.unclear for m in medicines) and "unclear_rows" not in reasons:
        reasons.append("unclear_rows")

    return NormalizedSchedule(
        doc_id=doc.doc_id,
        model=doc.model,
        medicines=medicines,
        unparsed_lines=list(doc.unparsed_lines),
        needs_review=doc.needs_review or bool(reasons),
        review_reasons=reasons,
    )
