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
            form=raw.get("form"),
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
