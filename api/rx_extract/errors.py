"""Shared exception types for rx-extract's pipelines."""


class MissingCredentialsError(RuntimeError):
    """Raised once at pipeline construction time when a required credential
    (API key, service account, etc.) is not configured. Never raised
    per-document — a missing credential is an infra failure to fail fast
    on, not a data-quality issue to skip-and-record.
    """


class VLMError(RuntimeError):
    """Base class for Pipeline B provider-call failures."""


class VLMBlockedError(VLMError):
    """The provider returned a terminal non-STOP finish reason (safety filter,
    recitation block, prohibited content, prompt-level block). This is a
    deterministic property of this image + model pair, so it is never retried.

    Raised rather than returned so a refusal can never be scored as "the model
    read this page and genuinely found no medicines" — the two are completely
    different outcomes and conflating them is a safety problem, not a cosmetic
    one (design doc §2, S2).
    """


class VLMTransientError(VLMError):
    """A failure worth retrying: timeout, connection error, 429, 5xx, or a
    degraded 200 response (no candidates/choices and no block reason). Raised
    to the caller only after all retry attempts are exhausted.
    """


class VLMCallError(VLMError):
    """A non-retryable call failure, e.g. 401/403 from a bad or missing key."""
