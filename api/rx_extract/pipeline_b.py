"""Pipeline B: VLM direct extraction. Source of truth: design doc §4.2."""
import base64
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import requests

from .errors import (
    MissingCredentialsError,
    VLMBlockedError,
    VLMCallError,
    VLMTransientError,
)
from .json_parsing import build_medicine_from_dict, parse_model_json
from .schema import ExtractionDocument, TokenUsage

PROMPTS_DIR = Path(__file__).parent / "prompts"

VLMClient = Callable[[bytes, str], "str | VLMResponse"]


@dataclass
class VLMProviderConfig:
    provider: str
    model: str
    api_key_env: str


DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BACKOFF_BASE = 1.0

# Cap on how long a Retry-After header can force us to wait. A broken or
# hostile header (e.g. "Retry-After: 999999") must not be able to stall a run
# indefinitely.
MAX_RETRY_AFTER = 60.0

# 408 request-timeout, 409 conflict, 425 too-early, 429 rate-limited, 5xx server-side.
# Everything else in the 4xx range is a client mistake (bad key, bad model name,
# malformed payload) — retrying those just burns quota and delays the real error.
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


def _parse_retry_after(response) -> float | None:
    """Parse the integer-seconds form of a Retry-After header (RFC 7231's
    HTTP-date form is not handled — none of this project's providers send it).
    Returns None if the header is absent or unparseable, so the caller falls
    back to exponential backoff rather than crashing on a malformed value.
    """
    raw = getattr(response, "headers", None)
    if not raw:
        return None
    value = raw.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return min(seconds, MAX_RETRY_AFTER)


@dataclass(frozen=True)
class VLMResponse:
    """What a provider call returns. A bare `str` is still accepted from an
    injected client and wrapped by `_coerce_response`, so existing mocks and any
    future provider that reports no usage data keep working unchanged.
    """

    text: str
    finish_reason: str | None = None
    usage: TokenUsage | None = None


def _scrub(text: str, secret: str | None) -> str:
    """Remove an API key from text before it goes into an exception message.

    Provider error bodies are genuinely useful for debugging (a 400 from Groq
    tells you exactly what was wrong with the payload), but this project has
    already leaked a key into an HTTP traceback once — see the git history on
    src/pipeline_a.py. Include the body, but never the credential.
    """
    if not secret:
        return text
    return text.replace(secret, "***")


def _post_with_retry(
    url: str,
    headers: dict,
    payload: dict,
    parse: Callable[[dict], "VLMResponse"],
    timeout: float,
    max_attempts: int,
    backoff_base: float,
    secret: str | None = None,
) -> "VLMResponse":
    """POST with exponential backoff, then hand the decoded body to `parse`.

    Retries transport-level failures (timeout, connection error, 429, 5xx,
    non-JSON body) and parse-level transient signals (`VLMTransientError`, which
    a provider parser raises for a degraded 200 that carried no candidates and
    no block reason). Never retries `VLMBlockedError` — a safety block is
    deterministic for this image + model, so retrying wastes quota and delays a
    result that will not change.

    Follows the same retry conventions as `_azure_submit_with_retry` in
    src/pipeline_a.py: retry connection errors / timeouts / 429 / 5xx, raise
    immediately on any other 4xx.
    """
    safe_url = _scrub(url, secret)
    last_error: Exception | None = None
    next_sleep: float | None = None
    for attempt in range(max_attempts):
        if attempt:
            sleep_for = next_sleep if next_sleep is not None else backoff_base * (2 ** (attempt - 1))
            next_sleep = None
            time.sleep(sleep_for)
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=timeout)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last_error = VLMTransientError(
                f"{type(exc).__name__} on attempt {attempt + 1}/{max_attempts} for {safe_url}"
            )
            continue
        except requests.exceptions.RequestException as exc:
            # Anything else requests can raise — notably InvalidHeader, whose
            # message echoes the offending header value verbatim (i.e. the API
            # key). Scrub it and drop the chained context, whose traceback
            # carries the same value.
            raise VLMCallError(
                f"{type(exc).__name__} for {safe_url}: {_scrub(str(exc), secret)}"
            ) from None

        if response.status_code in _RETRYABLE_STATUS:
            if response.status_code == 429:
                next_sleep = _parse_retry_after(response)
            last_error = VLMTransientError(
                f"HTTP {response.status_code} on attempt {attempt + 1}/{max_attempts} for {safe_url}"
            )
            continue
        if response.status_code >= 400:
            body = _scrub(getattr(response, "text", "") or "", secret)[:200]
            raise VLMCallError(f"HTTP {response.status_code} from {safe_url}: {body}")

        try:
            data = response.json()
        except ValueError:
            last_error = VLMTransientError(
                f"non-JSON body on attempt {attempt + 1}/{max_attempts} for {safe_url}"
            )
            continue

        try:
            return parse(data)
        except VLMTransientError as exc:
            last_error = exc
            continue

    raise last_error if last_error is not None else VLMTransientError(f"no attempts made for {safe_url}")


def _anthropic_call(
    image_bytes: bytes,
    prompt: str,
    model: str,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> "VLMResponse":
    raise NotImplementedError(
        "anthropic provider not wired up yet — the Messages API uses a different "
        "request/response shape (stop_reason, usage.input_tokens/output_tokens) "
        "than the OpenAI-compatible providers, and no live key exists to verify it against."
    )


def _detect_mime_type(image_bytes: bytes) -> str:
    if image_bytes[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if image_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"


# OpenAI-compatible chat-completions bases. Groq speaks the same wire format as
# OpenAI (which is why src/pipeline_a.py points the openai SDK at Groq), so one
# implementation serves both. Verified live against Groq on 2026-08-30; the
# OpenAI base URL uses the identical shape but has not been exercised live.
OPENAI_COMPATIBLE_BASES = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
}

# finish_reason values that mean "no usable output, retrying will not help".
_OPENAI_TERMINAL_REASONS = {"content_filter"}


def _openai_usage(usage: dict | None) -> TokenUsage | None:
    if not isinstance(usage, dict):
        return None
    return TokenUsage(
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
        total_tokens=usage.get("total_tokens"),
    )


def _parse_openai_response(data: dict) -> VLMResponse:
    usage = _openai_usage(data.get("usage"))
    choices = data.get("choices") or []
    if not choices:
        raise VLMTransientError("provider returned no choices")

    choice = choices[0]
    finish_reason = choice.get("finish_reason")
    text = (choice.get("message") or {}).get("content") or ""

    if finish_reason in _OPENAI_TERMINAL_REASONS:
        raise VLMBlockedError(f"provider stopped early: finish_reason={finish_reason}")
    if finish_reason and finish_reason not in ("stop", "length"):
        raise VLMBlockedError(f"provider returned an unrecognised finish_reason={finish_reason}")
    if finish_reason == "length":
        return VLMResponse(text=text, finish_reason="length", usage=usage)

    return VLMResponse(text=text or "[]", finish_reason=finish_reason or "stop", usage=usage)


def _make_openai_compatible_call(base_url: str) -> Callable:
    def call(
        image_bytes: bytes,
        prompt: str,
        model: str,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ) -> VLMResponse:
        data_uri = (
            f"data:{_detect_mime_type(image_bytes)};base64,"
            f"{base64.b64encode(image_bytes).decode('ascii')}"
        )
        payload = {
            "model": model,
            "temperature": 0,
            # Prescriptions with many medicines need room; without this some
            # providers default low enough to truncate mid-JSON.
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_uri}},
                    ],
                }
            ],
        }
        return _post_with_retry(
            f"{base_url}/chat/completions",
            {"Authorization": f"Bearer {api_key}"},
            payload,
            _parse_openai_response,
            timeout=timeout,
            max_attempts=max_attempts,
            backoff_base=DEFAULT_BACKOFF_BASE,
            secret=api_key,
        )

    return call


# Gemini finish reasons that mean "no usable output, and retrying will not help".
# Anything not STOP and not MAX_TOKENS is treated as terminal — an unrecognised
# reason is safer treated as a refusal than silently accepted as an empty read.
_GOOGLE_TERMINAL_REASONS = {
    "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST",
    "SPII", "IMAGE_SAFETY", "LANGUAGE", "MALFORMED_FUNCTION_CALL", "OTHER",
}


def _google_usage(meta: dict | None) -> TokenUsage | None:
    if not isinstance(meta, dict):
        return None
    return TokenUsage(
        prompt_tokens=meta.get("promptTokenCount"),
        completion_tokens=meta.get("candidatesTokenCount"),
        total_tokens=meta.get("totalTokenCount"),
    )


def _parse_google_response(data: dict) -> VLMResponse:
    usage = _google_usage(data.get("usageMetadata"))
    candidates = data.get("candidates") or []

    block_reason = (data.get("promptFeedback") or {}).get("blockReason")
    if block_reason:
        raise VLMBlockedError(f"Gemini blocked the prompt: blockReason={block_reason}")
    if not candidates:
        # HTTP 200 with no candidates and no stated block reason is a degraded
        # response, not a genuine "no medicines found" — retry it.
        raise VLMTransientError("Gemini returned no candidates and no blockReason")

    candidate = candidates[0]
    finish_reason = candidate.get("finishReason")
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))

    if finish_reason in _GOOGLE_TERMINAL_REASONS:
        raise VLMBlockedError(f"Gemini stopped early: finishReason={finish_reason}")
    if finish_reason and finish_reason not in ("STOP", "MAX_TOKENS"):
        raise VLMBlockedError(f"Gemini returned an unrecognised finishReason={finish_reason}")
    if finish_reason == "MAX_TOKENS":
        # Truncated, but whatever parsed is real — keep it and let the caller
        # flag the document rather than dropping partial output.
        return VLMResponse(text=text, finish_reason="MAX_TOKENS", usage=usage)

    return VLMResponse(text=text or "[]", finish_reason=finish_reason or "STOP", usage=usage)


def _google_call(
    image_bytes: bytes,
    prompt: str,
    model: str,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> VLMResponse:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": _detect_mime_type(image_bytes),
                            "data": base64.b64encode(image_bytes).decode("ascii"),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {"temperature": 0},
    }
    return _post_with_retry(
        url,
        {"x-goog-api-key": api_key},
        payload,
        _parse_google_response,
        timeout=timeout,
        max_attempts=max_attempts,
        backoff_base=DEFAULT_BACKOFF_BASE,
        secret=api_key,
    )


PROVIDERS: dict[str, Callable] = {
    "anthropic": _anthropic_call,
    "openai": _make_openai_compatible_call(OPENAI_COMPATIBLE_BASES["openai"]),
    "groq": _make_openai_compatible_call(OPENAI_COMPATIBLE_BASES["groq"]),
    "google": _google_call,
}

# Providers registered in PROVIDERS but not actually implemented yet. A known
# provider name should still fail fast at construction time, the same as an
# unknown one — not silently construct and only blow up per-document on the
# first (and every subsequent) run().
_STUB_PROVIDERS = {"anthropic"}


def _load_prompt(filename: str) -> str:
    return (PROMPTS_DIR / filename).read_text()


def _build_medicines_from_vlm(raw_list: list[dict]) -> tuple[list, list[str]]:
    medicines = []
    failed_lines = []
    for i, raw in enumerate(raw_list, start=1):
        med = build_medicine_from_dict(raw, i)
        if med is not None:
            medicines.append(med)
        elif isinstance(raw, dict):
            raw_line = raw.get("raw_line")
            failed_lines.append(raw_line if isinstance(raw_line, str) else "")
        else:
            failed_lines.append("")
    return medicines, failed_lines


def _coerce_response(result) -> VLMResponse:
    """Accept either a rich VLMResponse from a real provider or a bare string
    from an injected test client / a provider with no usage reporting."""
    if isinstance(result, VLMResponse):
        return result
    if isinstance(result, str):
        return VLMResponse(text=result)
    raise TypeError(f"vlm_client returned {type(result).__name__}; expected str or VLMResponse")


def _env_number(env: dict, key: str, default, cast):
    """Read a numeric setting from env, falling back to the default if it is
    absent or unparseable. A typo in a config value must not take down a run."""
    raw = env.get(key)
    if raw is None:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return default


def make_pipeline_b(
    provider_config: VLMProviderConfig | None = None,
    vlm_client: VLMClient | None = None,
    env: dict | None = None,
    prompt_version: str | None = None,
    timeout: float | None = None,
    max_attempts: int | None = None,
) -> Callable[[Path, str], ExtractionDocument]:
    env = env if env is not None else os.environ

    resolved_timeout = (
        timeout if timeout is not None else _env_number(env, "PIPELINE_B_TIMEOUT", DEFAULT_TIMEOUT, float)
    )
    if resolved_timeout <= 0:
        # A zero or negative timeout fails every request instantly; treat it
        # the same as an unset/unparseable value.
        resolved_timeout = DEFAULT_TIMEOUT
    resolved_max_attempts = (
        max_attempts
        if max_attempts is not None
        else _env_number(env, "PIPELINE_B_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, int)
    )
    # A max_attempts of 0 (or negative) makes the retry loop body never run,
    # so every document dies with "no attempts made". At least one attempt
    # must always happen.
    resolved_max_attempts = max(1, resolved_max_attempts)

    if vlm_client is None and provider_config is None:
        provider = env.get("PIPELINE_B_PROVIDER")
        model = env.get("PIPELINE_B_MODEL")
        if provider and model:
            api_key_env = env.get("PIPELINE_B_API_KEY_ENV", f"{provider.upper()}_API_KEY")
            provider_config = VLMProviderConfig(provider=provider, model=model, api_key_env=api_key_env)

    if vlm_client is None:
        if provider_config is None:
            raise MissingCredentialsError(
                "pipeline_b needs a vlm_client, an explicit provider_config, or "
                "PIPELINE_B_PROVIDER + PIPELINE_B_MODEL env vars set."
            )
        call_fn = PROVIDERS.get(provider_config.provider)
        if call_fn is None:
            raise ValueError(f"unknown provider '{provider_config.provider}'; registered: {sorted(PROVIDERS)}")
        api_key = (env.get(provider_config.api_key_env) or "").strip()
        if not api_key:
            raise MissingCredentialsError(
                f"{provider_config.api_key_env} is not set; pipeline_b cannot run with "
                f"provider '{provider_config.provider}'."
            )
        if provider_config.provider in _STUB_PROVIDERS:
            # Fail at construction, not per-document — a stub provider would
            # otherwise raise NotImplementedError on the first run(), then
            # again after every retry, once per document, for all 50 documents.
            raise NotImplementedError(
                f"provider '{provider_config.provider}' is registered but not implemented yet."
            )
        model_id = provider_config.model
        vlm_client = lambda image_bytes, prompt: call_fn(
            image_bytes, prompt, model_id, api_key,
            timeout=resolved_timeout, max_attempts=resolved_max_attempts,
        )
        model_name = f"{provider_config.provider}:{model_id}"
    else:
        model_name = f"{provider_config.provider}:{provider_config.model}" if provider_config else "injected-client"

    resolved_prompt_version = prompt_version or env.get("PIPELINE_B_PROMPT_VERSION", "v1")
    prompt_template = _load_prompt(f"extract_vlm_{resolved_prompt_version}.md")

    def run(image_path: Path, doc_id: str) -> ExtractionDocument:
        image_bytes = Path(image_path).read_bytes()
        response = _coerce_response(vlm_client(image_bytes, prompt_template))
        medicines_raw = parse_model_json(response.text)
        medicines, failed_lines = _build_medicines_from_vlm(medicines_raw)

        review_reasons = []
        if not medicines:
            review_reasons.append("no_medicines_parsed")
        if failed_lines:
            review_reasons.append("unparsed_lines")
        if response.finish_reason in ("MAX_TOKENS", "length"):
            # Output was cut off mid-JSON. Whatever parsed is kept; the document
            # is flagged so a reviewer knows medicines may be missing entirely.
            review_reasons.append(f"vlm_finish_reason:{response.finish_reason}")

        return ExtractionDocument(
            doc_id=doc_id,
            extracted_at=datetime.now(timezone.utc),
            pipeline="vlm_direct",
            model=model_name,
            prompt_version=resolved_prompt_version,
            usage=response.usage,
            medicines=medicines,
            unparsed_lines=failed_lines,
            needs_review=bool(review_reasons),
            review_reasons=review_reasons,
        )

    return run
