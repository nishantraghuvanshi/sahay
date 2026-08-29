"""Pydantic models for the rx-extract extraction schema.

Source of truth: medicall-features/OCR/docs/prescription-extraction-design.md
§5.1 (extraction output) and §6.2 (ground truth format).
"""
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class Form(str, Enum):
    tablet = "tablet"
    capsule = "capsule"
    syrup = "syrup"
    injection = "injection"
    ointment = "ointment"
    drops = "drops"
    sachet = "sachet"
    nebuliser = "nebuliser"


class ScheduleSlot(str, Enum):
    morning = "morning"
    afternoon = "afternoon"
    night = "night"


class FoodRelation(str, Enum):
    before = "before"
    after = "after"


class Flag(str, Enum):
    low_confidence = "low_confidence"
    pipeline_disagreement = "pipeline_disagreement"
    unknown_brand = "unknown_brand"
    implausible_duration = "implausible_duration"
    implausible_schedule = "implausible_schedule"
    strength_not_in_formulary = "strength_not_in_formulary"
    illegible = "illegible"
    exclude_from_calls = "exclude_from_calls"


class Stratum(str, Enum):
    printed_clean = "printed_clean"
    printed_poor = "printed_poor"
    handwritten_legible = "handwritten_legible"
    handwritten_difficult = "handwritten_difficult"
    mixed_script = "mixed_script"


class TokenUsage(BaseModel):
    """Per-document token counts, as reported by the provider. Every field is
    optional because not every provider reports every count, and a missing
    count must be representable as "unknown" rather than silently zero.
    """

    model_config = ConfigDict(extra="forbid")

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


class MedicineExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    raw_line: str
    brand: str | None = None
    generic: str | None = None
    form: Form | None = None
    strength: str | None = None
    dose_amount: str | None = None
    schedule: list[ScheduleSlot] = Field(default_factory=list)
    food: FoodRelation | None = None
    duration_days: int | None = None
    prn: bool = False
    confidence: float = Field(ge=0.0, le=1.0)
    flags: list[Flag] = Field(default_factory=list)


class ExtractionDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    doc_id: str
    extracted_at: datetime
    pipeline: str
    model: str
    prompt_version: str | None = None
    usage: TokenUsage | None = None
    medicines: list[MedicineExtraction] = Field(default_factory=list)
    unparsed_lines: list[str] = Field(default_factory=list)
    needs_review: bool
    review_reasons: list[str] = Field(default_factory=list)


class GroundTruthMedicine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    raw_line: str
    brand: str | None = None
    generic: str | None = None
    form: Form | None = None
    strength: str | None = None
    dose_amount: str | None = None
    schedule: list[ScheduleSlot] = Field(default_factory=list)
    food: FoodRelation | None = None
    duration_days: int | None = None
    prn: bool = False


class GroundTruthDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    doc_id: str
    stratum: Stratum
    redacted: bool
    medicines: list[GroundTruthMedicine] = Field(default_factory=list)
    unparsed_lines: list[str] = Field(default_factory=list)
