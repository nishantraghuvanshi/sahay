"""Tests for prescription reading: the pipeline, normalize, and /extract.

Zero network calls — every test injects a fake VLM client, which is the discipline
the upstream suite follows and the only way to exercise a safety refusal on demand.

The three paths the integration handoff names as where integrations go wrong get
first billing: a blocked refusal must propagate, a needs_review document must not
look confirmable, and unparsed_lines must be surfaced rather than dropped.
"""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api import main as api_main
from api.rx_extract import VLMBlockedError, VLMResponse, VLMTransientError, make_pipeline_b
from api.rx_extract.normalize import STRENGTH_UNKNOWN, normalize
from api.rx_extract.schema import Flag, TokenUsage

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64

MEALS = {"breakfast": "08:00", "lunch": "13:30", "dinner": "20:30"}


def med(**over):
    base = {
        "raw_line": "1) T. Dolo 650  1-0-1  x 5 days  (a/f)",
        "brand": "Dolo 650", "generic": "Paracetamol", "form": "tablet",
        "strength": "650mg", "schedule": ["morning", "night"], "food": "after",
        "duration_days": 5, "prn": False, "confidence": 0.94,
    }
    base.update(over)
    return base


@pytest.fixture
def image(tmp_path):
    p = tmp_path / "rx.png"
    p.write_bytes(PNG)
    return p


def run_with(payload, **kw):
    """A pipeline whose VLM returns exactly `payload` (str or VLMResponse)."""
    client = payload if callable(payload) else (lambda image_bytes, prompt: payload)
    return make_pipeline_b(vlm_client=client, env={}, **kw)


# --------------------------------------------------------------- refusal path

def test_blocked_error_propagates_and_is_not_an_empty_document(image):
    """The single most important property in this module.

    A safety refusal must reach the caller as an exception. If it were ever
    converted into an ExtractionDocument with no medicines, "the model refused to
    read this page" would become indistinguishable from "this page has no
    medicines on it" — and the second one is a schedule a caregiver might sign.
    """
    def refuse(image_bytes, prompt):
        raise VLMBlockedError("Gemini stopped early: finishReason=SAFETY")

    with pytest.raises(VLMBlockedError):
        run_with(refuse)(image, "rx_blocked")


def test_blocked_is_not_retried(image):
    """A block is deterministic for this image + model, so retrying only wastes
    quota and delays a result that will not change."""
    calls = []

    def refuse(image_bytes, prompt):
        calls.append(1)
        raise VLMBlockedError("finishReason=PROHIBITED_CONTENT")

    with pytest.raises(VLMBlockedError):
        run_with(refuse, max_attempts=5)(image, "rx_blocked")
    assert len(calls) == 1


# ------------------------------------------------------- review-signal paths

def test_unparsed_lines_are_surfaced_not_dropped(image):
    """A medicine that fails schema validation must still leave a trace. Silently
    discarding it would understate the prescription without anyone noticing."""
    payload = json.dumps([med(), {"raw_line": "2) T. ??? illegible", "confidence": "not-a-number"}])
    doc = run_with(payload)(image, "rx_unparsed")

    assert len(doc.medicines) == 1
    assert doc.unparsed_lines == ["2) T. ??? illegible"]
    assert doc.needs_review is True
    assert "unparsed_lines" in doc.review_reasons

    schedule = normalize(doc, MEALS)
    assert schedule.unparsed_lines == ["2) T. ??? illegible"]
    assert schedule.needs_review is True


def test_no_medicines_parsed_flags_review(image):
    doc = run_with("[]")(image, "rx_empty")
    assert doc.medicines == []
    assert doc.needs_review is True
    assert "no_medicines_parsed" in doc.review_reasons


def test_truncated_output_is_flagged(image):
    """MAX_TOKENS means medicines may be missing from the page entirely — the
    partial result is kept, but the document cannot pass as complete."""
    def truncated(image_bytes, prompt):
        return VLMResponse(text=json.dumps([med()]), finish_reason="MAX_TOKENS",
                           usage=TokenUsage(total_tokens=1115))

    doc = run_with(truncated)(image, "rx_truncated")
    assert doc.needs_review is True
    assert "vlm_finish_reason:MAX_TOKENS" in doc.review_reasons
    assert normalize(doc, MEALS).needs_review is True


# ------------------------------------------------------------------ normalize

def test_slots_expand_against_caregiver_meal_times(image):
    """morning+night, after food, breakfast 08:00 / dinner 20:30 -> 08:30, 21:00."""
    doc = run_with(json.dumps([med()]))(image, "rx1")
    row = normalize(doc, MEALS).medicines[0]

    assert row.name == "Dolo 650"
    assert row.dose == "650mg"
    assert row.slots == ["08:30", "21:00"]
    assert row.with_food == "after"
    assert row.unclear is False
    assert row.raw_line == "1) T. Dolo 650  1-0-1  x 5 days  (a/f)"


def test_before_food_shifts_earlier_and_absent_food_does_not_shift(image):
    doc = run_with(json.dumps([
        med(schedule=["morning"], food="before"),
        med(schedule=["morning"], food=None),
    ]))(image, "rx2")
    rows = normalize(doc, MEALS).medicines
    assert rows[0].slots == ["07:30"]
    assert rows[1].slots == ["08:00"]
    assert rows[1].with_food == "any"


def test_slot_offset_wraps_around_midnight(image):
    doc = run_with(json.dumps([med(schedule=["night"], food="after")]))(image, "rx3")
    row = normalize(doc, {"breakfast": "08:00", "lunch": "13:30", "dinner": "23:45"}).medicines[0]
    assert row.slots == ["00:15"]


def test_malformed_meal_time_falls_back_to_default(image):
    doc = run_with(json.dumps([med(schedule=["morning"], food=None)]))(image, "rx4")
    row = normalize(doc, {"breakfast": "not-a-time"}).medicines[0]
    assert row.slots == ["08:00"]


def test_prn_is_extracted_but_never_scheduled(image):
    """Safety rule 4. The row is still shown — dropping it would mean the caregiver
    never learns the SOS medicine on the page was read at all."""
    doc = run_with(json.dumps([med(prn=True, raw_line="2) T. Meftal SOS")]))(image, "rx5")
    row = normalize(doc, MEALS).medicines[0]

    assert row.excluded is True
    assert row.slots == []
    assert "SOS" in row.exclusion_reason
    # Excluded rows never block sign-off: nothing will be scheduled from them.
    assert row.unclear is False


@pytest.mark.parametrize("form", ["injection", "ointment", "drops"])
def test_non_oral_forms_are_excluded_from_calls(image, form):
    doc = run_with(json.dumps([med(form=form)]))(image, "rx6")
    row = normalize(doc, MEALS).medicines[0]
    assert row.excluded is True
    assert row.slots == []
    assert Flag.exclude_from_calls in row.flags


def test_low_confidence_marks_the_row_unclear(image):
    doc = run_with(json.dumps([med(confidence=0.41)]))(image, "rx7")
    row = normalize(doc, MEALS).medicines[0]
    assert Flag.low_confidence in row.flags
    assert row.unclear is True
    assert normalize(doc, MEALS).needs_review is True


def test_abstained_strength_is_never_invented(image):
    """Design doc S2: ambiguous -> null + review, never a plausible guess."""
    doc = run_with(json.dumps([med(strength=None, dose_amount=None)]))(image, "rx8")
    row = normalize(doc, MEALS).medicines[0]
    assert row.dose == ""
    assert row.unclear is True


@pytest.mark.parametrize("amount", ["1", "2", "\u00bd", "1/2", "1.5"])
def test_bare_count_with_no_strength_is_treated_as_unknown(image, amount):
    """Observed live on gemini-3.5-flash-lite: where the line carries no written
    strength, the model reports dose_amount "1" \u2014 lifted off the leading digit of
    the 1-0-1 notation, not off the paper \u2014 at 0.95 confidence with no flag.
    Showing that as a dose would be presenting an inferred value as a read one."""
    doc = run_with(json.dumps([med(strength=None, dose_amount=amount)]))(image, "rx_bare")
    row = normalize(doc, MEALS).medicines[0]

    assert row.dose == ""
    assert STRENGTH_UNKNOWN in row.flags
    assert row.unclear is True


@pytest.mark.parametrize("amount", ["2 tsp", "10 ml", "2 puffs"])
def test_dose_amount_with_a_unit_is_a_real_reading_and_kept(image, amount):
    doc = run_with(json.dumps([med(strength=None, dose_amount=amount)]))(image, "rx_amt")
    row = normalize(doc, MEALS).medicines[0]

    assert row.dose == amount
    assert STRENGTH_UNKNOWN not in row.flags


def test_a_written_strength_wins_over_a_bare_count(image):
    """The rule must not fire when the strength was genuinely read."""
    doc = run_with(json.dumps([med(strength="650mg", dose_amount="1")]))(image, "rx_both")
    row = normalize(doc, MEALS).medicines[0]

    assert row.dose == "650mg"
    assert STRENGTH_UNKNOWN not in row.flags
    assert row.unclear is False


def test_implausible_duration_is_flagged_not_corrected(image):
    doc = run_with(json.dumps([med(duration_days=400)]))(image, "rx9")
    row = normalize(doc, MEALS).medicines[0]
    assert Flag.implausible_duration in row.flags
    assert row.duration_days == 400  # preserved, not silently clamped
    assert row.unclear is True


def test_priority_is_never_assigned_by_the_machine(image):
    """FR-2: at most one priority medicine, and it is the caregiver's choice."""
    doc = run_with(json.dumps([med(), med(schedule=["morning"])]))(image, "rx10")
    assert all(m.is_priority is False for m in normalize(doc, MEALS).medicines)


# ------------------------------------------------------------------- endpoint

@pytest.fixture
def client(monkeypatch):
    with TestClient(api_main.app) as c:
        yield c


def set_pipeline(monkeypatch, fn):
    monkeypatch.setitem(api_main._state, "extract", fn)
    monkeypatch.setitem(api_main._state, "config_error", None)


def post(client, content=PNG, mime="image/png", meals=MEALS):
    data = {"meal_times": json.dumps(meals)} if meals is not None else {}
    return client.post("/extract", files={"file": ("rx.png", content, mime)}, data=data)


def test_endpoint_returns_a_reviewable_schedule(client, monkeypatch):
    set_pipeline(monkeypatch, run_with(json.dumps([med()])))
    body = post(client).json()

    assert body["ok"] is True
    row = body["schedule"]["medicines"][0]
    assert row["slots"] == ["08:30", "21:00"]
    assert row["raw_line"]  # S3: the reviewer needs it to check against the photo


def test_endpoint_reports_a_refusal_as_blocked_never_as_an_empty_schedule(client, monkeypatch):
    """The refusal must arrive as its own kind, flagged for a human. If this ever
    returned ok:true with an empty medicines list, the app would tell a caregiver
    the prescription had no medicines on it."""
    def refuse(path, doc_id):
        raise VLMBlockedError("finishReason=SAFETY")

    set_pipeline(monkeypatch, refuse)
    body = post(client).json()

    assert body["ok"] is False
    assert body["error"]["kind"] == "blocked"
    assert body["error"]["needs_human_review"] is True
    assert body["error"]["retryable"] is False
    assert "schedule" not in body


def test_endpoint_marks_a_transient_failure_retryable(client, monkeypatch):
    def flaky(path, doc_id):
        raise VLMTransientError("HTTP 503 on attempt 3/3")

    set_pipeline(monkeypatch, flaky)
    body = post(client).json()
    assert body["error"]["kind"] == "transient"
    assert body["error"]["retryable"] is True


def test_endpoint_rejects_a_pdf_rather_than_mislabelling_it(client, monkeypatch):
    """pipeline_b's mime sniffer falls back to image/jpeg for anything it does not
    recognise, so an accepted PDF would be sent to the model as a broken JPEG."""
    set_pipeline(monkeypatch, run_with("[]"))
    r = client.post("/extract", files={"file": ("rx.pdf", b"%PDF-1.4", "application/pdf")})
    assert r.status_code == 415
    assert r.json()["error"]["kind"] == "unsupported_media"


def test_endpoint_reports_missing_configuration_rather_than_pretending(client, monkeypatch):
    monkeypatch.setitem(api_main._state, "extract", None)
    monkeypatch.setitem(api_main._state, "config_error", "MissingCredentialsError: GOOGLE_API_KEY is not set")
    r = post(client)
    assert r.status_code == 503
    assert r.json()["error"]["kind"] == "config"


def test_endpoint_never_leaves_the_uploaded_image_on_disk(client, monkeypatch, tmp_path):
    """DPDP: keep the schedule, not the photograph."""
    seen = {}

    def capture(path, doc_id):
        seen["path"] = Path(path)
        assert seen["path"].exists()  # present during the call...
        return run_with(json.dumps([med()]))(path, doc_id)

    set_pipeline(monkeypatch, capture)
    assert post(client).json()["ok"] is True
    assert not seen["path"].exists()  # ...and gone after it


def test_health_reports_extraction_availability(client, monkeypatch):
    set_pipeline(monkeypatch, run_with("[]"))
    assert client.get("/health").json()["extraction_available"] is True


# ------------------------------------------------- provider request shape

def test_a_reasoning_model_is_not_sent_the_parameters_it_rejects():
    """gpt-5 and the o-series answer HTTP 400 to `max_tokens` ("Unsupported
    parameter ... use max_completion_tokens instead") and to any temperature but
    the default. Both were being sent, so every request failed before the image
    was ever looked at."""
    from api.rx_extract import pipeline_b as pb

    captured = {}

    def fake_post(url, headers, payload, parse, **kw):
        captured.update(payload)
        return VLMResponse(text="[]")

    call = pb._make_openai_compatible_call("https://api.openai.com/v1")
    orig, pb._post_with_retry = pb._post_with_retry, fake_post
    try:
        call(b"\xff\xd8\xff", "prompt", "gpt-5-nano", "sk-test")
        assert captured["max_completion_tokens"] == pb.REASONING_MAX_TOKENS
        assert "max_tokens" not in captured
        assert "temperature" not in captured

        captured.clear()
        call(b"\xff\xd8\xff", "prompt", "gpt-4o-mini", "sk-test")
        assert captured["max_tokens"] == pb.DEFAULT_MAX_TOKENS
        assert captured["temperature"] == 0
        assert "max_completion_tokens" not in captured
    finally:
        pb._post_with_retry = orig


def test_the_reasoning_budget_leaves_room_for_the_thinking():
    """A live gpt-5-nano read of a four-medicine page spent 1920 tokens reasoning
    before emitting 336 of JSON. The ordinary 2048 ceiling truncates that mid-object,
    which arrives as unparseable JSON rather than as an error."""
    from api.rx_extract import pipeline_b as pb

    assert pb.REASONING_MAX_TOKENS > pb.DEFAULT_MAX_TOKENS * 2


@pytest.mark.parametrize("written,expected", [
    ("Tab.", "tablet"), ("T.", "tablet"), ("tab", "tablet"),
    ("Inj.", "injection"), ("Cap.", "capsule"), ("Syp.", "syrup"),
    ("Neb.", "nebuliser"), ("tablet", "tablet"),
])
def test_a_prescription_abbreviation_for_form_does_not_lose_the_medicine(written, expected):
    """`form` is a closed enum, so a model echoing the prefix it read — "Tab." —
    failed validation for the whole medicine and the caregiver was told the
    prescription could not be read. gpt-5-nano did exactly that on every line of a
    perfectly legible page."""
    from api.rx_extract.json_parsing import build_medicine_from_dict

    med = build_medicine_from_dict(
        {"raw_line": "T. Metformin 500mg", "generic": "Metformin", "form": written,
         "confidence": 0.9},
        1,
    )
    assert med is not None, f"{written!r} lost the medicine"
    assert med.form.value == expected


def test_an_unknown_form_is_still_refused():
    """The alias table is a vocabulary mapping, not a licence to invent. A form
    nobody can name must still fail rather than be coerced to something plausible."""
    from api.rx_extract.json_parsing import build_medicine_from_dict

    assert build_medicine_from_dict(
        {"raw_line": "x", "form": "lozenge", "confidence": 0.9}, 1
    ) is None
