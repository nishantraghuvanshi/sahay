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
| — | Borderline note corrected back to `IDEA_SCOPE` §9 wording — **pre-product, no codebase**, never pitched or demoed; prior work is market research and a no-code voice agent | The README and the T-0 checklist had drifted into claiming "a prior codebase exists". The founder confirms there is none, and `~/Desktop/projects/sahay-archive/` does not exist on disk. ⚠️ The 20:23 Aug 29 row below still describes moving "a working codebase" out — **reconcile that row before the submission note is final** |

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
