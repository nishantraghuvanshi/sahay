# T-0 BLOCK — All four together
### 18:30–19:30 IST · Nothing else starts until this is done

> **Rule:** no feature code before this block closes. A wrong answer to V1 or V2
> invalidates the architecture, not just a component.

**Exit criterion:** tool contract frozen, repo exists, five verifications answered,
four lanes assigned to four named people.

---

## A. Compliance — settle before kickoff (17:00–17:30, at check-in)

- [ ] Ask a mentor, verbatim:
  > *"I'm a founder — pre-product in elder-care voice AI. A prior codebase exists
  > for a related use case; I will not open it, use it, or show it. If I build from
  > zero today in the same domain, is that clean? Does it change if I reuse the brand name?"*
- [ ] **Get a name.** Write down who answered and what they said
- [ ] Confirm among yourselves: has any of this been **pitched or demoed at another event?**
      (`[V]` hard disqualifier, no borderline path)
- [ ] Agree the submitted product name — **not Voxikin**, and "Sahay" is a placeholder
- [ ] Move `docs/Archive 2/` **out of the project directory** to a sibling folder.
      It contains a working codebase for the same use case **and a `.env` with live
      Sarvam + Groq API keys.** Gitignoring is not enough — one `git add -f` ships a
      disqualifier and two live credentials into a public repo
- [ ] Draft the borderline note with **accurate** wording (see `IDEA_SCOPE` §9, but
      correct "no codebase" → "prior codebase exists, not used, not opened, not shown")

## B. The five blocking verifications

| # | Question | Owner | If the answer is bad |
|---|---|---|---|
| **V1** | What exactly is "the Hive stack"? | ALL | **Blocking.** Re-plan before any code |
| **V2** | Is Emergent required or merely sponsored? | ALL | Hand-build the app, costs ~6h |
| **V3** | Exact inbound caller-ID variable ElevenLabs exposes on Twilio inbound | A | Ask-for-number fallback (TRD §5.4) |
| **V4** | Live per-minute rates — ElevenLabs, Twilio US→IN, LLM | D | Unit economics cannot be stated |
| **V5** | Can the agent take dynamic variables at call start? | A | Turn-zero `get_care_context` call, +1 round trip |

- [ ] **V1** — answered, written down
- [ ] **V1 mitigation ready before you ask:** the Hive stack is a unified model router
      (Claude 3.5 Sonnet / Llama-3-70b / Gemma-3 / DeepSeek-R1). ElevenLabs Agents
      supports a **custom LLM endpoint** — point it at the Hive router. Voice transport
      stays ElevenLabs, the reasoning layer runs on-stack. Propose this, don't wait to be told
- [ ] **V2** — answered
- [ ] **V3** — answered (A proceeds with the fallback regardless)
- [ ] **V4** — three rates recorded with a timestamp and a screenshot
- [ ] **V5** — answered

## C. Repo

- [ ] **First commit after 18:00.** Repo does not exist before T-0 (`CC-1`)
- [ ] `.gitignore` with `.env` **in commit 1** (`NFR-7`)
- [ ] Directory skeleton: `/agent /api /app /handoff /scripts /evidence /docs`
- [ ] `.env.example` with every key named, no values
- [ ] Four branches: `lane-a` `lane-b` `lane-c` `lane-d`
- [ ] `README.md` stub — build instructions are a **submission requirement**

## D. Freeze the tool contract  🚩 **HARD GATE T+1h**

> Nothing else in the build matters as much as freezing this on time.
> Once frozen it is **not renegotiated**.

- [ ] All 7 request/response shapes written into `agent/tools.json`
- [ ] Convention agreed: `POST`, JSON, Bearer auth, 3s hard timeout
- [ ] **Always HTTP 200.** Errors are `{"ok": false, "error": "..."}` — a non-2xx makes
      the agent stall and the parent hears silence (`NFR-6`)
- [ ] Idempotency keys named: `log_dose` on `(medication_id, slot_time)`, `upsert_intake` on `session_id`
- [ ] Lane B commits a **mock API** returning canned contract-shaped responses.
      A and C consume the mock, never each other's real work

## E. Assign the lanes

- [ ] **Lane A — Voice.** The strongest realtime-voice person. Critical path, longest pole
- [ ] **Lane B — Memory & API.** Six of twelve components
- [ ] **Lane C — App & handoff.** Lowest coupling
- [ ] **Lane D — Evidence, revenue, submission.** *Not a consolation role — two of six
      scored surfaces live here, and the video is the judged artifact for all but the top 3*
- [ ] If you have a **fifth person**: second body on Lane A. That is where the build slips

## F. Ownership calls the docs leave ambiguous — decide now

- [ ] **Pricing page + checkout → Lane D**, entirely. (§3 says C, TRD §1.2 says D, TRD §13 says C)
- [ ] **Twilio number purchase → Lane D. Routing → Lane A.** (Purchase is a card transaction)
- [ ] **Appointment reminders** — cut in PRD §14, sold in the Care+ tier in §15.
      Pick one: mark "coming soon" on the pricing page, or delete from the tier
- [ ] **Impact number** — the rubric grades Impact by *how much a metric moves*
      (<5% = L2, 5–10% = L3, 10–30% = L4, >30% = L5). The PRD names no delta.
      Agree a defensible adherence-improvement claim now, or you score L2 on a
      parameter your research already earns L4 on

---

## The gates — miss one, cut scope, do not extend

| Gate | Time | Condition |
|---|---|---|
| Tool contract frozen | **T+1h** · 19:30 | Not renegotiated |
| Outbound writes a `dose_event` | T+5h · 23:30 | |
| **Hang up mid-intake, partial record persists** | T+8h · 02:30 | The FR-14 test |
| First full end-to-end call | **T+11.5h** · 06:00 | Or drop resume-after-drop |
| R1 passes cold | T+14h · 08:30 | |
| **Feature freeze** | **T+17.5h** · 12:00 | Absolute |
| **Video locked** | **T+20.5h** · 15:00 | |
| Submit | T+22.5h · 17:00–18:00 | |
