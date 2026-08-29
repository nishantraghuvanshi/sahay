"""Care API. spec: TRD §5.1

Currently hosts one real route: prescription extraction (Pipeline B). The agent
tool endpoints are still stubs under api/tools/.

Error convention follows NFR-6 — an outcome the caller must *render* comes back
HTTP 200 with `{ok: false}` and a typed `kind`, because the request itself
succeeded. Only malformed requests and infrastructure faults use 4xx/5xx.
"""
import json
import logging
import os
import secrets
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.rx_extract import (
    MissingCredentialsError,
    VLMBlockedError,
    VLMCallError,
    VLMTransientError,
    VLMProviderConfig,
    make_pipeline_b,
)
from api.rx_extract.normalize import normalize
from api import db
from api.routes_app import router as app_router

load_dotenv()

log = logging.getLogger("kinvox.api")

# Matches the caregiver app's own limit in app/src/screens/setup/Prescription.tsx.
MAX_UPLOAD_BYTES = 10 * 1_048_576

# Only what the pipeline can genuinely read. `_detect_mime_type` in pipeline_b.py
# recognises JPEG and PNG and silently falls back to "image/jpeg" for anything
# else — so a PDF would be base64'd and labelled as a JPEG, and the model would be
# handed garbage. Rejecting here with a clear message beats a confident misread.
ACCEPTED_MIME = {"image/jpeg", "image/png"}

# Populated at startup. A pipeline that could not be built leaves the reason here
# so /extract can report a configuration fault instead of pretending to work.
_state: dict = {"extract": None, "config_error": None}


def _build_pipeline():
    """Build the extraction pipeline once, at startup.

    The handoff is emphatic that this is a factory to build eagerly: it validates
    credentials up front so a missing key raises here rather than on the first
    uploaded prescription. We honour that, but keep the process alive on failure —
    the rest of the API must still boot for a developer without a VLM key, and the
    fault is surfaced loudly in the log, on /health, and on every /extract call.
    """
    provider = os.getenv("PIPELINE_B_PROVIDER", "google")
    model = os.getenv("PIPELINE_B_MODEL", "gemini-3.5-flash-lite")
    api_key_env = os.getenv("PIPELINE_B_API_KEY_ENV", f"{provider.upper()}_API_KEY")
    return make_pipeline_b(
        provider_config=VLMProviderConfig(provider=provider, model=model, api_key_env=api_key_env),
        env=os.environ,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Schema first: the read endpoints must work even if no VLM key is configured.
    # Seeding only runs on an empty database, so a restart never overwrites a
    # schedule someone signed off through the app.
    db.init()
    log.info("database ready at %s", db.DB_PATH)
    try:
        _state["extract"] = _build_pipeline()
        log.info("pipeline_b ready")
    except (MissingCredentialsError, ValueError, NotImplementedError, FileNotFoundError) as exc:
        _state["config_error"] = f"{type(exc).__name__}: {exc}"
        log.error("pipeline_b NOT available — /extract will fail: %s", _state["config_error"])
    yield


app = FastAPI(title="Kinvox Care API", lifespan=lifespan)

# Caregiver-app reads and the onboarding write.
app.include_router(app_router)

# The caregiver app runs on a different origin in development (Vite on :5173).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _fail(kind: str, message: str, *, retryable: bool, needs_human_review: bool, status: int = 200):
    return JSONResponse(
        status_code=status,
        content={
            "ok": False,
            "error": {
                "kind": kind,
                "message": message,
                "retryable": retryable,
                "needs_human_review": needs_human_review,
            },
        },
    )


def _new_doc_id() -> str:
    """Opaque and time-ordered. Deliberately carries no patient identifier — it
    ends up in logs, and safety rule 5 keeps identifiers out of them."""
    return f"rx_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{secrets.token_hex(3)}"


@app.get("/health")
def health():
    return {
        "ok": True,
        "extraction_available": _state["extract"] is not None,
        "config_error": _state["config_error"],
    }


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    meal_times: str | None = Form(default=None),
):
    """One prescription photograph in, one reviewable schedule out.

    The result is NOT a confirmed schedule. Nothing here may reach the reminder
    scheduler without an explicit caregiver sign-off (design doc §2, S1) — that
    gate lives on the review screen, and `needs_review: false` does not bypass it.
    """
    if _state["extract"] is None:
        return _fail(
            "config",
            f"Extraction is not configured on the server. {_state['config_error']}",
            retryable=False,
            needs_human_review=False,
            status=503,
        )

    if file.content_type not in ACCEPTED_MIME:
        return _fail(
            "unsupported_media",
            f"{file.content_type or 'that file type'} cannot be read. Send a JPEG or PNG photo.",
            retryable=False,
            needs_human_review=False,
            status=415,
        )

    image_bytes = await file.read()
    if not image_bytes:
        return _fail("empty_file", "The uploaded file was empty.", retryable=False,
                     needs_human_review=False, status=400)
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        return _fail(
            "too_large",
            f"That image is {len(image_bytes) / 1_048_576:.1f} MB; the limit is 10 MB.",
            retryable=False, needs_human_review=False, status=413,
        )

    meals = None
    if meal_times:
        try:
            parsed = json.loads(meal_times)
            if isinstance(parsed, dict):
                meals = {k: v for k, v in parsed.items() if isinstance(v, str)}
        except json.JSONDecodeError:
            # Not worth failing the upload over — normalize falls back to the
            # documented default anchors and the caregiver can adjust the times.
            log.warning("meal_times was not valid JSON; using defaults")

    doc_id = _new_doc_id()

    # run() reads from disk, so an in-memory upload has to be spooled. The file is
    # deleted in `finally` and never written anywhere durable: under the DPDP Act
    # the photograph is health data, and the record we keep is the schedule, not
    # the image.
    tmp = tempfile.NamedTemporaryFile(suffix=Path(file.filename or "").suffix or ".jpg", delete=False)
    tmp_path = Path(tmp.name)
    try:
        tmp.write(image_bytes)
        tmp.close()

        # No retry loop here on purpose: backoff and Retry-After already live
        # inside the pipeline's HTTP client, and wrapping it would multiply the
        # wait and re-retry things deliberately marked non-retryable.
        doc = _state["extract"](tmp_path, doc_id)

    except VLMBlockedError as exc:
        # The model REFUSED. This is emphatically not "the page had no medicines"
        # — conflating the two is the exact failure this pipeline exists to
        # prevent, so it gets its own kind and routes to a human. Retrying is
        # pointless: a block is deterministic for this image and model.
        log.warning("doc_id=%s blocked by provider: %s", doc_id, exc)
        return _fail(
            "blocked",
            "The model declined to read this image. It has not been read — this needs a person to look at it.",
            retryable=False,
            needs_human_review=True,
        )
    except VLMTransientError as exc:
        log.warning("doc_id=%s transient failure after retries: %s", doc_id, exc)
        return _fail(
            "transient",
            "Could not reach the reading service. Try again in a moment.",
            retryable=True,
            needs_human_review=False,
        )
    except VLMCallError as exc:
        log.error("doc_id=%s call error (configuration/infra): %s", doc_id, exc)
        return _fail(
            "config",
            "The reading service rejected the request. This is a server configuration problem.",
            retryable=False,
            needs_human_review=False,
            status=502,
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    schedule = normalize(doc, meal_times=meals)

    # Extracted fields and flags are fine to log; the image and any patient
    # identifier are not (safety rule 5).
    log.info(
        "doc_id=%s model=%s medicines=%d unparsed=%d needs_review=%s reasons=%s",
        doc.doc_id, doc.model, len(doc.medicines), len(doc.unparsed_lines),
        schedule.needs_review, schedule.review_reasons,
    )

    return {
        "ok": True,
        "schedule": schedule.model_dump(mode="json"),
        "usage": doc.usage.model_dump() if doc.usage else None,
    }
