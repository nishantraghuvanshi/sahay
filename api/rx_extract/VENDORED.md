# Vendored: Pipeline B (VLM prescription extraction)

Copied, not linked. Upstream is a separate git repository with **no remote
configured**, so a submodule was not possible without first publishing it.

| | |
|---|---|
| Source | `medicall-features/rx-extract/` in the `voiceAgentCall` repo |
| Upstream commit | `140b64f` — *docs: add Pipeline B integration handoff* |
| Vendored on | 2026-08-30 |
| Integration brief | upstream `docs/PIPELINE_B_HANDOFF.md` |
| Domain source of truth | upstream `medicall-features/OCR/docs/prescription-extraction-design.md` |

## Files taken

`pipeline_b.py`, `schema.py`, `errors.py`, `json_parsing.py`,
`prompts/extract_vlm_v1.md`.

Not taken: `pipeline_a.py` (Vision-API pipeline), `preprocess.py`, `crosscheck.py`,
the eval harness, and the upstream test suite — none are on Pipeline B's path.

## Changes made to the copies

Deliberately minimal, so a future re-vendor is a re-copy plus these same two edits:

1. **Imports.** Upstream imports absolutely from its repo root
   (`from src.errors import ...`); those became package-relative
   (`from .errors import ...`) in `pipeline_b.py` and `json_parsing.py`.
2. **Prompt path.** `PROMPTS_DIR` was `Path(__file__).parent.parent / "prompts"`,
   because upstream keeps `prompts/` a level above `src/`. Here `prompts/` lives
   inside the package, so it is `Path(__file__).parent / "prompts"`.

Nothing else was touched. Comments that reference `src/pipeline_a.py` are upstream's
and were left as-is — they are accurate about where the retry conventions came from.

## Dependencies

`requests` and `pydantic` only. The handoff also lists `pillow`, but nothing in
Pipeline B's actual import closure uses it — verified against these four files.

## Do not "fix" these things

They are load-bearing, not oversights:

- `run()` **raises** `VLMBlockedError` instead of returning an empty document. A
  refusal and a genuine "no medicines on this page" must never be the same value.
  Never wrap a call site in a broad `except Exception`.
- Retry, backoff and `Retry-After` handling already live in `_post_with_retry`.
  Do not add an outer retry loop, and do not retry `VLMBlockedError` — it is
  deterministic for a given image + model.
- Output is **not** safe to act on unreviewed. `needs_review: false` still requires
  an explicit human confirmation before any schedule reaches a reminder.

## Accuracy

0.980 mean composite over 49/50 documents, `google:gemini-3.5-flash-lite`, on
**synthetic** data — rendered prescriptions, not photographs of handwritten ones.
Do not present that number as real-world accuracy.
