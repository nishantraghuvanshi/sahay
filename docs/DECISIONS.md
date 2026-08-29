# Decisions

Append-only. One line per decision, newest at the bottom. Thirty seconds to write.

**Why this file exists:** things reshape fast in a 24-hour build. This stops the 4 AM
argument about whether something was already settled, and it hands Lane D the raw
material for the README and the GTM brief.

**Format:** `HH:MM · what was decided — why`. If a decision reverses an earlier one, add
a new line, don't edit the old one. The trail matters.

---

## Locked before T-0

Carried in from `IDEA_SCOPE.md` §2. **Do not reopen during the build.**

| # | Decision | Why |
|---|---|---|
| 1 | Declared job is **produce the intake record + handoff**, never "triage the patient" | Triage has no obtainable ground truth in 24h; 12 checkable fields do. Caps at rubric L3 vs L5 |
| 2 | Primary track is **Revenue** | ICP is physically in the room; one real transaction is the cheapest L5 on the board |
| 3 | **US Twilio number** | An Indian DID needs a regulatory bundle, up to 3 business days. Impossible in-window |
| 4 | **Outbound is thin.** It exists to seed memory. Inbound is the hero | Outbound alone is a commodity; the loop between directions is the product |
| 5 | **No** acoustic distress detection · **no** diagnosis · **no** dispatch claim | Unverifiable across 3 cold runs, and each invites a challenge that cannot be won |
| 6 | Priority is **rule-cited**, and the UI renders the rule string | Converts a subjective judgment into an auditable one. Evidence for Memory L5 |
| 7 | Product name is **not Voxikin** — settled 30 Aug: **Kinvox** | Handbook rule 04. A distinct name keeps the build clear of the founder's company brand |
| 8 | Tool contract frozen at **T+1h**, not renegotiated | The only interface all four lanes share |

---

## Aug 29 — build night

| Time | Decision | Why |
|---|---|---|
| ~19:20 | Empty private repo `sahay` created on GitHub | `CC-1` — repo must not exist before T-0 (18:30). Timestamp is the proof |
| 20:23 | **Archive moved out of the project** to `~/Desktop/projects/sahay-archive/` — both `Archive 2/` and `Archive 2.zip` | It held a working codebase for the same use case *and* a `.env` with live Sarvam + Groq keys. Gitignoring is one `git add -f` away from shipping a disqualifier and two credentials into a public repo |
| 20:30 | Repo stays **private now, flip to public at submission** | A half-built repo shouldn't be public during judging prep; a credential accident shouldn't be permanently indexed |
| 20:30 | **Single `main` branch.** No per-lane branches | At hackathon pace, four branches cost more in merge friction than they save. Mitigated by directory ownership instead |
| 20:30 | **Empty stubs**, not working stubs | Faster to a landing spot for every lane; the critical-path files get filled first anyway |
| 20:30 | Generated artifacts (`.docx`, `.html`, `.zip`) are **gitignored** | The `.md` is the source of truth; binaries bloat diffs and go stale silently |
| 20:35 | **Pricing page + checkout → Lane D**, entirely | Three docs contradicted each other (`IDEA_SCOPE` §3 said C, `TRD` §1.2 said D, `TRD` §13 said C). It has zero API dependency and it is D's track proof |
| 20:35 | **Twilio purchase → D. Routing → A.** | Purchase is a card transaction; routing is config |
| 21:00 | **No AI attribution in commits**, PRs, or docs | Authorship is the team's to present. In a judged submission, tooling trailers in the history are a signal we don't want to send |
| 21:05 | **Notion owns checklist *state*. The repo owns checklist *content*.** State never flows back | Two-way sync would need the Notion API, conflict resolution, and a babysitter. The repo checklists also stay in git as context for anyone reading the code |
| 21:05 | **Directory ownership per lane**, enforced socially not by tooling | Git only fights you when two people write the same file. Four people on one branch is fine if nobody writes outside their directory |

---

## Aug 30

| Time | Decision | Why |
|---|---|---|
| — | **Product name settled: Kinvox.** Renamed across docs, checklists and both wireframe files (`sahay.app` → `kinvox.app`). Placeholder history: MediWatch → Sahay → *(briefly Voxikin)* → **Kinvox** | Closes locked decision 7 and `IDEA_SCOPE` §9 item 1. Kinvox is distinct from the founder's company brand, so `[V]` rule 04 (*"if your company builds in this space, you can't demo your existing product"*) is satisfied without a mentor ruling on brand reuse |
| — | Borderline note corrected back to `IDEA_SCOPE` §9 wording — **pre-product, no codebase**, never pitched or demoed; prior work is market research and a no-code voice agent | The README and the T-0 checklist had drifted into claiming "a prior codebase exists". The founder states there is none. ⚠️ **Not yet reconciled — see the note below.** |
| 02:37 | **Pipeline B (VLM prescription extraction) vendored into `api/rx_extract/`** from `voiceAgentCall/medicall-features/rx-extract` @ `140b64f`. Copied, not submoduled | Upstream is a separate git repo with **no remote**, so a submodule was impossible without publishing it first. Provenance and the two edits made (relative imports, prompt path) are recorded in `api/rx_extract/VENDORED.md` |
| 02:41 | `api/rx_extract/normalize.py` **written here, not vendored** — it does not exist upstream. Expands the model's abstract `morning/afternoon/night` slots to clock times, anchored on the caregiver's own meal times rather than the design doc's fixed 08:00/14:00/20:00 | The app's `DraftMedicine.slots` needs `'HH:MM'` and the pipeline emits abstract slots, so nothing could consume the output without it. Anchoring on real meal times is the difference between a reminder at breakfast and one an hour before it |
| 02:44 | Lane B's `api/` opened for this work at the founder's explicit go-ahead; first real FastAPI app written in `api/main.py` (`/extract`, `/health`) | `api/` was 100% four-line stubs, so there was no backend to add a route to. Lane ownership waived deliberately, not by accident |
| 02:46 | A model refusal is its own outcome end to end: `VLMBlockedError` → `{kind:'blocked', needs_human_review:true}` → a distinct "not read" panel. It is never rendered as an empty schedule | "The safety filter blocked this" and "I read the page and there are no medicines" are different facts, and the second is a schedule someone might sign off. Collapsing them is the exact failure the pipeline was built to prevent |
| 02:48 | Prescription upload narrowed to **JPEG/PNG only**; PDF and HEIC now rejected at both the picker and the endpoint | `_detect_mime_type` silently falls back to `image/jpeg` for anything it does not recognise, so an accepted PDF would have been base64'd and handed to the model as a broken JPEG — a confident misreading of garbage |
| 02:50 | The fake upload progress bar on `1c` removed; the photo is now staged in memory and sent once, on `1d`, as part of the real extraction request | There is a real transfer now, and it happens on the next screen. An animated bar describing a network call that never happened was the one remaining lie in the flow |
| 02:52 | ⚠️ **Origin claim 2 below is now false and needs the founder's wording.** `api/` contains ~700 lines of pre-kickoff code: `rx-extract`'s first commit is **2026-08-23**, six days before the 29 Aug kickoff | The claim reads *"every prompt and every line of `api/` was written after kickoff"*. That was true when written and is not any more. This is a **second** prior codebase, separate from `sahay-archive` — and unlike the archive, this one **is** in the repo and **was** copied. Surfacing only; the origin note is the founder's to word |
| 03:05 | **Live-verified against ground truth**, 5 synthetic documents, `google:gemini-3.5-flash-lite`, ~2.5s and ~2.2k tokens each. All 5 came back `needs_review:false` at 0.95–0.98 confidence while 11 of 18 rows differed from the label and 5 carried an invented dose | This is the design doc's own S1 rationale reproduced live — *"the output is well-formed, confident, and wrong"*. Recorded as evidence that the mandatory sign-off gate is load-bearing, not ceremony. Note the numbers use strict equality and are **not** comparable to upstream's fuzzy-matched 0.980 composite |
| 03:08 | `normalize` now blanks a **bare unitless `dose_amount`** (`1`, `2`, `½`, `1/2`) when no strength was read, raises `strength_unknown`, and marks the row unclear. A dose_amount carrying a unit (`2 tsp`, `10 ml`) is kept | Where the line has no written strength the model lifts `"1"` off the leading digit of the `1-0-1` notation and reports it at 0.95 confidence with no flag of its own. Showing that as a dose presents an inferred value as a read one (S2). Verified live: the three affected documents now surface the rows instead of passing them |
| 03:09 | `strength_unknown` kept **out** of the vendored `Flag` enum; `NormalizedMedicine.flags` widened to `list[str]` | It is a normalization outcome, not something the extractor reported. Keeping it out leaves `api/rx_extract/schema.py` byte-identical to upstream, so re-vendoring stays a copy plus the two edits in `VENDORED.md` |
| 03:22 | **Bug: `1d` hung on "still reading…" and never issued a request.** The `AbortController` in the effect's cleanup was removed; the StrictMode single-flight ref stays | StrictMode runs setup → cleanup → setup. Cleanup aborted the only run, then the second setup hit the `started` ref and declined to start another, so `fetch` rejected with `AbortError` before leaving the browser and the row froze at `reading`. Confirmed by the API log: zero browser-originated `POST /extract`. Not aborting costs little — a caregiver who navigates away mid-read finds the result waiting instead of paying for a second extraction |
| 03:24 | Every path out of `runExtraction` now resolves its row: a per-page `catch`, plus a `finally` that demotes any row still `pending`/`reading` to `failed` with a retry | The original failure was silent and terminal — no error, no retry, no way forward. A row stuck in `reading` should be structurally impossible, not merely fixed this once |
| 03:26 | ⚠️ **The app has no test setup**, so this class of bug is uncovered. The 33 Python tests exercise the pipeline, normalize and `/extract`; nothing exercises a React effect | Worth `vitest` + `@testing-library/react` if there is time — a StrictMode double-invoke test would have caught this before it reached a demo |
| 03:38 | **Bug: a second prescription showed the first one's medicines.** `ExtractionMeta` now records `source_files` (the `DraftFile` ids it was read from), and `1d` re-reads whenever the current files differ from those | The guard was `if (draft.ocrDone) return`, which persists in localStorage. It only says *a* prescription was read, not *which*, so a new photograph was suppressed and the previous reading rendered underneath it — looking read, and one tap from being signed off. The worst shape this bug could take |
| 03:40 | A new read now clears `medicines`/`extraction` before it starts, rather than after it succeeds | Otherwise the old prescription's rows sit under the new photograph while it reads, and survive as a signable schedule if the new read fails |
| 03:48 | **Extraction split onto its own base URL** (`EXTRACT_API_BASE`, `VITE_EXTRACT_API_BASE`) rather than sharing `API_BASE` | Pointing the single `API_BASE` switch at the extraction service 404'd every screen in the app: `hooks.ts` reads one flag to choose mock-or-live for *everything*, so enabling one real endpoint switched off the mock for the eight that do not exist yet. One switch cannot describe two backends with different readiness |
| 04:05 | **Care API built for real** — `api/schema.sql` (TRD §3 in SQLite), `api/db.py`, `api/routes_app.py`: the six `/app/*` reads, `/h/{token}`, and `POST /app/onboarding` | The onboarding draft was a dead end — extract a prescription, confirm it, and the calendar still showed fixture data, because nothing posted anywhere. SQLite so it runs from a clone with nothing to provision; column names and nullability are TRD §3 unchanged, so Postgres is a type substitution |
| 04:07 | The database **seeds from `scripts/mock-api.json`** (TRD §3.2) and only when empty | Seeding from the same fixture Lane C built every screen against means the live endpoints return shapes the app already renders, so mock → live is a base-URL change and not a debugging session. Seeding only on an empty database means a restart never overwrites a schedule someone signed off |
| 04:09 | **The FR-4 sign-off is enforced server-side**: `POST /app/onboarding` refuses an unsigned schedule, an empty one, or two priority medicines; `medications.confirmed_by`/`confirmed_at` are `NOT NULL` | A rule that lives only in a disabled button is not a rule — anything can POST. Design doc §10 is explicit that the confirmation fields are required rather than nullable-with-a-default, because a nullable `confirmed_by` is a gate that defaults to open |
| 04:12 | **The intro call is a first-class calendar event**, plus a banner while `intro_call_status` is `pending` | A schedule can be signed off and entirely dormant — no dose may be dialled until the parent has agreed on the intro call. If the calendar only drew doses, a caregiver would see a full week of reminders with no way to tell that none of them will ring |
| 04:14 | Extraction provenance now survives confirmation: `raw_line`, `confidence`, `extraction_flags`, `source_doc_id`, `excluded`/`exclusion_reason` are columns on `medications` | Closes SCHEMA-GAPS §7. Previously the evidence for every row was discarded the moment a caregiver signed off, leaving "Metformin 500mg at 08:30" with no record of what the paper said or how sure the model was |
| 04:32 | **Vitest + Testing Library added to `app/`**, with the suite rendering real screens rather than testing helpers | Two React lifecycle bugs reached a live screen past a fully green 55-test Python suite, because neither was reachable from a pure function. Both now have a regression test, and both were verified by reintroducing the bug and watching the tests fail — 4 failures for the StrictMode abort, 1 for the stale re-read guard. A test that passes on broken code is worth nothing |
| 04:34 | `clearFiles()` added and called once onboarding saves | Prescription photographs are held in memory for the length of the flow; keeping them past the point the schedule is stored is what DPDP guidance says not to do. It also gives the tests isolation, since the staged-image map is module scope |
| 04:35 | `@types/node` added as a dev dependency | `vite.config.ts` imports `node:url` and the repo had no node types, so `npm run typecheck` failed on a clean checkout. Unrelated to the test work but fixed while the build config was open |

---

## Still open — resolve and record here

| # | Open question | Owner | Blocking? |
|---|---|---|---|
| 1 | **V1 — what exactly is "the Hive stack"?** Proposed mitigation: point ElevenLabs' custom LLM endpoint at the Hive model router, so voice transport stays ElevenLabs and the reasoning layer runs on-stack | ALL | **Yes** — rule 01 lists another stack as a disqualifier |
| 2 | **V2** — is Emergent required or merely sponsored? | ALL | Costs ~6h if required and we assumed otherwise |
| 3 | **V3** — exact inbound caller-ID variable | A | No — the ask-for-number fallback is unconditional |
| 4 | **V4** — live per-minute rates for the economics table | D | No, but needed before the video |
| 5 | **V5** — dynamic variables at call start? | A | No — costs one round trip if unavailable |
| 6 | **The Impact number.** The rubric grades Impact by how far a metric moves (<5%=L2, 5–10%=L3, 10–30%=L4, >30%=L5). No delta is currently claimed | ALL | No, but it silently costs two levels |
| 7 | **Appointment reminders** — cut in `PRD` §14, sold in the Care+ tier in §15. Mark "coming soon" or delete from the tier | D | No, but a judge is likely to open the pricing page |
| 8 | ~~**Product name**~~ — **settled 30 Aug: Kinvox** | ALL | Closed |
| 9 | **Lane owners.** Four lanes are defined; the people are not | ALL | **Yes** — Lane A is the critical path |

---

## ⚠️ Unreconciled — settle before the submission note is final

Two statements in this log contradict each other. Recording what is **verifiable on disk**
so the founder can settle the wording; nobody else should edit the origin note.

**Verified 30 Aug 00:35, by direct filesystem check:**

| Check | Result |
|---|---|
| `~/Desktop/projects/sahay-archive/` exists | **Yes** — 15 MB, created 29 Aug 20:23 |
| Contents | `Archive 2/` and `Archive 2.zip` |
| `Archive 2/va/va/src/` | **35 source files** |
| `Archive 2/va/va/package.json` → `name` | `elderly-voice-agent` |
| `Archive 2/va/va/.env` | populated `SARVAM_API_KEY`, `GROQ_API_KEY`, `API_KEY` |
| Anything from it inside this repo | **No** — confirmed absent from every commit |

So the Aug 30 row's claim that the directory "does not exist on disk" is **incorrect**;
it was moved there at 20:23 on 29 Aug and is still there. The 20:23 row is accurate as written.

**What is genuinely unsettled is whose work it is.** `Archive 2/va/PRODUCT-BRIEF.md` names
its owner as **Anmol**, while `PRD.md` and `TRD.md` name the owner as **Shubh Sankalp Das**.
If the archive is a teammate's or a third party's prior work rather than the submitting
founder's, then "pre-product, no codebase" may be accurate *about the submitter* and the
two rows are not actually in conflict.

**Three things are true regardless of how that resolves, and none of them are at risk:**

1. No archive code, config, or data is in this repo, and none was opened or copied
2. Every prompt and every line of `api/` was written after kickoff
3. The archive sits outside the repo and cannot be swept in by `git add`

**Decide before submission:** whether the origin note says *"no codebase"* or
*"a prior codebase exists for a related use case; it was not used, opened, or shown."*
The handbook's rule is that **hiding the origin is an auto-disqualification** while a
flagged borderline case is cleared by a mentor — so the more disclosive wording carries
less risk if there is any doubt about attribution. This is the founder's call, not a
drafting decision.

**Unrelated but pending:** the live `SARVAM_API_KEY` and `GROQ_API_KEY` in
`Archive 2/va/va/.env` should be rotated whenever there is a spare minute.
