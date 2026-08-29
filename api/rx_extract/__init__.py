"""Pipeline B — VLM prescription extraction. Vendored; see VENDORED.md.

Re-exports the public surface so callers write `from api.rx_extract import ...`
rather than reaching into module paths that only exist because of how the
upstream repo happened to be laid out.

`make_pipeline_b` is a factory: build it once at startup so a missing key raises
immediately instead of on the first uploaded prescription.
"""
from .errors import (
    MissingCredentialsError,
    VLMBlockedError,
    VLMCallError,
    VLMError,
    VLMTransientError,
)
from .pipeline_b import VLMProviderConfig, VLMResponse, make_pipeline_b
from .schema import (
    ExtractionDocument,
    Flag,
    FoodRelation,
    Form,
    MedicineExtraction,
    ScheduleSlot,
    TokenUsage,
)

__all__ = [
    "make_pipeline_b",
    "VLMProviderConfig",
    "VLMResponse",
    "ExtractionDocument",
    "MedicineExtraction",
    "TokenUsage",
    "Form",
    "ScheduleSlot",
    "FoodRelation",
    "Flag",
    "MissingCredentialsError",
    "VLMError",
    "VLMBlockedError",
    "VLMTransientError",
    "VLMCallError",
]
