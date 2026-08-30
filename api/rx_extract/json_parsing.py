"""Shared JSON-defensive-parsing and medicine-construction logic, used by
both src/pipeline_a.py and src/pipeline_b.py so the two pipelines don't
duplicate identical model-response handling.
"""
import json

from pydantic import ValidationError

from .schema import MedicineExtraction


def parse_model_json(raw: str) -> list[dict]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[len("json"):]
        text = text.strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and "medicines" in data:
        medicines = data["medicines"]
        return medicines if isinstance(medicines, list) else []
    if isinstance(data, list):
        return data
    return []


# Prescription abbreviations -> the `Form` enum.
#
# Belt and braces with the prompt, which now names the closed set. The prompt
# alone is a request; a model that ignores it fails the whole document, because a
# `form` the enum rejects fails validation for the entire medicine and the
# caregiver is told their prescription could not be read. gpt-5-nano returned
# "Tab." and "Inj." for every line on a perfectly legible page and lost all four
# medicines that way.
#
# This is a vocabulary mapping, not an inference: every pair here is already
# written in the prompt's own decoding table, so nothing is being guessed about
# what the page said. An abbreviation with no entry stays unmapped and still
# fails, which is correct — that is a form we cannot name.
_FORM_ALIASES = {
    "t": "tablet", "t.": "tablet", "tab": "tablet", "tab.": "tablet", "tabs": "tablet",
    "cap": "capsule", "cap.": "capsule", "caps": "capsule",
    "syp": "syrup", "syp.": "syrup", "syr": "syrup", "syr.": "syrup",
    "inj": "injection", "inj.": "injection",
    "oint": "ointment", "oint.": "ointment",
    "drop": "drops",
    "neb": "nebuliser", "neb.": "nebuliser", "nebulizer": "nebuliser",
}


def _normalise_form(value):
    """Map a written form to the enum, or leave it for validation to reject."""
    if not isinstance(value, str):
        return value
    key = value.strip().lower()
    return _FORM_ALIASES.get(key, key)


def build_medicine_from_dict(raw: dict, index: int, fallback_raw_line: str = "") -> MedicineExtraction | None:
    if not isinstance(raw, dict):
        return None
    raw_line = raw.get("raw_line") or fallback_raw_line
    try:
        return MedicineExtraction(
            index=index,
            raw_line=raw_line,
            brand=raw.get("brand"),
            generic=raw.get("generic"),
            form=_normalise_form(raw.get("form")),
            strength=raw.get("strength"),
            dose_amount=raw.get("dose_amount"),
            schedule=raw.get("schedule") or [],
            food=raw.get("food"),
            duration_days=raw.get("duration_days"),
            prn=bool(raw.get("prn", False)),
            confidence=float(raw.get("confidence", 0.5)),
            flags=[],
        )
    except (ValidationError, ValueError, TypeError):
        return None
