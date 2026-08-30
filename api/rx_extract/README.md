# `rx_extract` — prescription reading

Kinvox's prescription-extraction module. A photograph of an Indian prescription goes
in; a structured, reviewable medicine schedule comes out, via a single vision-model
call. No OCR stage.

```python
from api.rx_extract import make_pipeline_b, VLMProviderConfig
from api.rx_extract.normalize import normalize

extract = make_pipeline_b(...)          # once, at startup — validates credentials
doc     = extract(Path("rx.png"), doc_id)
sched   = normalize(doc, meal_times)    # -> the shape the caregiver app renders
```

`api/main.py` owns the HTTP surface (`POST /extract`); this package owns the reading.

## Layout

| File | What it does |
|---|---|
| `pipeline_b.py` | The pipeline: `make_pipeline_b`, the provider clients, retry and backoff |
| `schema.py` | `ExtractionDocument`, `MedicineExtraction`, `TokenUsage` |
| `errors.py` | `VLMBlockedError`, `VLMTransientError`, `VLMCallError` |
| `json_parsing.py` | Defensive parsing of model output |
| `normalize.py` | Extraction output → the app's schedule shape, plus the §7 validation rules |
| `prompts/extract_vlm_v1.md` | The prompt. Encodes Indian dosing conventions |

## The design premise

This feeds a system that telephones patients about their medicine, so:

> **A wrong or invented value is far worse than an abstention, and no failure may be
> silently swallowed.**

Three consequences are load-bearing. They look like rough edges and are not:

1. **A refusal raises, it does not return empty.** `VLMBlockedError` means the model
   declined to read the image. "The safety filter blocked this" and "I read the page
   and there are genuinely no medicines" must never become the same value — the
   second is a schedule someone might sign off. Never wrap a call site in a broad
   `except Exception`.

2. **Retry lives inside the client.** `_post_with_retry` already does exponential
   backoff and honours `Retry-After`. Do not add an outer retry loop, and never retry
   `VLMBlockedError` — a block is deterministic for a given image and model.

3. **Output is not safe to act on unreviewed.** `needs_review: false` reduces how much
   a caregiver has to check; it does not replace the check. The sign-off gate on the
   review screen, and the server-side gate in `POST /app/onboarding`, are what let a
   schedule reach the scheduler.

`normalize.py` adds two rules of its own for the same reason: a bare unitless dose with
no strength (`"1"`, lifted off the leading digit of `1-0-1`) is treated as *strength
unknown* rather than shown as a reading, and PRN / injection / ointment / drops are
extracted and displayed but never scheduled.

## Providers

| `provider` | Model | Key | Verified live |
|---|---|---|---|
| `google` | `gemini-3.5-flash-lite` | `GOOGLE_API_KEY` | Yes — the accuracy baseline |
| `groq` | `qwen/qwen3.8-27b` | `GROQ_API_KEY` | Yes, but the free tier meters to roughly 2 documents/minute |
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` | No — same wire format as Groq, never run against a real key |
| `anthropic` | — | — | Stub. Raises `NotImplementedError` at construction |

Configure with `PIPELINE_B_PROVIDER` / `PIPELINE_B_MODEL`, or pass a
`VLMProviderConfig`. Optional: `PIPELINE_B_TIMEOUT` (60s), `PIPELINE_B_MAX_ATTEMPTS`
(3; use 7 on Groq).

## Accuracy

0.980 mean composite across 49/50 documents on `google:gemini-3.5-flash-lite`, against
a **synthetic** dataset — rendered prescriptions, not photographs of handwritten ones.
Do not present that as real-world accuracy.

Measured live against ground truth on five `handwritten_difficult` documents, every one
came back `needs_review: false` at 0.95–0.98 confidence while 11 of 18 rows differed
from the label. That is the whole argument for the human confirmation gate.

## Dependencies

`requests` and `pydantic`. Nothing else.

## Tests

`api/tests/test_rx_extract.py` — 33 tests, all mocked, zero network calls. Inject a fake
client rather than hitting an API. The paths worth keeping covered: a `VLMBlockedError`
propagating rather than being swallowed, a `needs_review` document being held back from
any scheduler, and `unparsed_lines` being surfaced rather than dropped.
