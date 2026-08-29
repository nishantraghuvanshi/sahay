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
| — | **Caregiver auth built in-house, not on a hosted identity provider.** Own OTP endpoints in `api/auth/`, opaque session in an httpOnly cookie, Postgres-backed | Auth appears in neither PRD nor TRD — `FR-1`'s acceptance is only *"record exists with phone in E.164"* — so there was nothing to conform to. Owning it kept caregiver identity in the TRD's own `caregivers` table with no second source of truth, and it forced `api/` to become a real application (app factory, pool, schema), which every other lane needed anyway |
| — | **`/auth/*` and `/app/*` return a real 401; the seven tools keep `TRD §5.1`'s always-200 envelope** | The always-200 rule exists because *"a non-2xx makes the agent stall and the parent hears silence"* — that reasoning is about the voice agent, not a browser. A route guard has to tell "signed out" from "endpoint broke", and only a status code carries that. Business failures (wrong code, rate limited) keep the envelope. The T+1h contract freeze covers the seven tools only, so nothing here renegotiates it |
| — | **Phone OTP goes over WhatsApp before SMS** | India's TRAI requires DLT registration for A2P SMS — days to weeks, and the copy freezes once approved. WhatsApp is not SMS, so it can go live the same day, and `TRD §9` already puts WhatsApp first on the escalation ladder. SMS stays as the second rung for caregivers who do not use WhatsApp |
| — | Borderline note corrected back to `IDEA_SCOPE` §9 wording — **pre-product, no codebase**, never pitched or demoed; prior work is market research and a no-code voice agent | The README and the T-0 checklist had drifted into claiming "a prior codebase exists". The founder states there is none. ⚠️ **Not yet reconciled — see the note below.** |

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
