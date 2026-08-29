# LANE A — VOICE
### Owns: ElevenLabs agent · all prompts · Twilio routing · both call directions · resume-after-drop

> **This is the critical path and the likeliest slip.** Longest pole in the build is
> inbound + resume. Everything Lane A builds talks to **the mock API**, never to
> Lane B's real work — swap the base URL at integration.

| | |
|---|---|
| **Owner** | _______________ |
| **Depends on** | Frozen tool contract (T+1h), mock API |
| **Blocks** | Cold runs (D), integration (all) |
| **Done when** | Outbound completes a dose confirmation · inbound opens naming ≥3 record facts unprompted · a dropped call resumes with nothing re-asked · p95 latency within TRD §14 |

---

# MVP — "the phone rings and it works"
### T+1 → T+5.5 (19:30 → 00:00) · Gate: T+5h, one outbound call writes a `dose_event`

## Telephony

- [ ] Purchased Twilio number confirmed to do **inbound and outbound** (`A1`)
- [ ] Verify: outbound to India works from the US number (`CC-4` — Indian carriers
      only accept international origination)
- [ ] Twilio native integration in the ElevenLabs dashboard: label + number + SID + auth token
- [ ] Assign the agent to the number
- [ ] Validate the Twilio webhook signature (`TRD §15`)
- [ ] Place one throwaway call end-to-end before writing a single prompt.
      *If telephony is broken, nothing downstream matters*

## Agent shell

- [ ] Create **one** agent, two entry modes. Not two agents — a guardrail that
      exists in two places drifts
- [ ] Voice: Flash v2.5 realtime tier
- [ ] Language: Hindi + English, code-switching allowed within one sentence (`NFR-4`)
- [ ] Set silence timeout → 6s (`PRD §9.1`)

## Prompt blocks — five files, in this order

> Guardrails come **last** so they are the most recent instruction in context.
> Every block written fresh on the floor. Do not copy from any prior file (`CC-2`).

- [ ] `agent/prompts/1-identity.md` — who the agent is, who set it up, why it is calling
- [ ] `agent/prompts/2-voice-rules.md`
  - [ ] One question per turn
  - [ ] Sentences under ~15 words
  - [ ] Respectful address (`Sharma-ji`), never first-name-only
  - [ ] Accept Hindi, English, or a mix within one sentence
  - [ ] Never require a keypad press (`P1`)
  - [ ] Confirm back what was heard before writing a clinical field
  - [ ] Never say a number, dosage, or medical term the record does not contain (`P3`)
- [ ] `agent/prompts/3a-mode-outbound-dose.md`
- [ ] `agent/prompts/5-guardrails.md` — **write this before any mode except outbound**
  - [ ] Never give a diagnosis or say what a symptom means (`SR-1`)
  - [ ] Never give a dose instruction, dose change, or treatment advice (`SR-1`)
  - [ ] Never say help / ambulance / doctor has been sent or called (`SR-3`)
  - [ ] On a red flag, exactly three things in order: acknowledge → *"please contact
        your doctor now"* → *"I am informing {caregiver_name} right now"* → call `escalate` (`SR-2`)
  - [ ] Never state a medicine, dose, condition, or allergy not in this call's context
  - [ ] If you do not know something, say so. Never fill a gap with a guess
  - [ ] If asked for medical advice: say you cannot, name the doctor, continue collecting

## Tools

- [ ] Register all 7 tools in the ElevenLabs dashboard, **pointed at the mock API**
- [ ] 3s hard timeout on every tool
- [ ] Fallback line per tool (`TRD §5.3`) — these are Lane A's strings:
  - [ ] `identify_caller` → *"Let me take your details fresh. Can you tell me your name?"*
  - [ ] `get_care_context` → *"I'll take everything from you directly."*
  - [ ] `upsert_intake` → *say nothing, continue collecting, retry next turn*
  - [ ] `escalate` → *"Please call your doctor now, and please also call {caregiver_name} directly."*
        **The important one — if the machine can't reach the caregiver, the human must be told to**
- [ ] Filler line while waiting on a tool (*"one moment"*) — never dead air

## Outbound flow (`J2`, `FR-6`–`FR-10`)

- [ ] Greets by respectful name with medicine and slot preloaded — **zero clarifying
      questions about identity** (`FR-7`)
- [ ] Asks whether the dose was taken
  - [ ] Taken → `log_dose(confirmed)`
  - [ ] Not yet → offer a callback interval → `log_dose(deferred)`
  - [ ] Cannot / refused → capture reason → `log_dose(missed)`
- [ ] One wellbeing question, answer captured **verbatim** → `log_observation` (`FR-9`)
- [ ] Red flag → SR-2 sequence, no interpretation → `escalate` (`FR-10`)
- [ ] Session closes, transcript stored

## Checks before leaving MVP

- [ ] **T+4h — Hindi voice listen test.** If quality is poor, switch voice now.
      English fallback only as a last resort
- [ ] 🚩 **T+5h GATE — an outbound call completes and a `dose_event` row exists**

---

# CORE — "the call already knows"
### T+5.5 → T+11.5 (00:00 → 06:00) · Gate: T+11.5h, full end-to-end

> This tier is the product. Everything above it is table stakes.

## Caller resolution — build the fallback FIRST

> Building the automatic path first and discovering at 2 AM that the variable is
> absent is the worst-case ordering.

- [ ] **Ask-for-number fallback** — unconditional, always works (`FR-18`, `TRD §5.4`)
  - [ ] Turn one: *"Can you tell me the phone number of the person this is about?"*
  - [ ] `identify_caller` with the spoken number
  - [ ] Everything downstream identical
- [ ] **Only then** wire the automatic caller-ID path, using the variable V3 confirmed
- [ ] Resolution completes **before the first agent turn** (`FR-11`, `NFR-3` ≤500ms)
- [ ] Unknown number → graceful, asks for the number, **never invents a record**

## Inbound intake (`J3`, `FR-11`–`FR-17`)

- [ ] `agent/prompts/3b-mode-inbound-intake.md`
- [ ] `identify_caller` → `resume_session` → `get_care_context` before the agent speaks
- [ ] **Opening names ≥3 record facts unprompted** (`FR-12`) —
      *"Hello Sharma-ji — is this about the chest discomfort you mentioned this morning?"*
- [ ] Asks **only the 6 unknown fields**, one per turn (`FR-13`)
  - [ ] 1 · caller identity + relationship
  - [ ] 3 · chief complaint, **verbatim**
  - [ ] 4 · onset time
  - [ ] 5 · responsive (yes/no/unsure)
  - [ ] 6 · breathing (normal/difficult/unsure)
  - [ ] 7 · location — **prefilled, confirm only**
- [ ] Never re-asks the 6 inherited fields (patient identity, medicines, allergies,
      conditions, callback number, priority)
- [ ] `upsert_intake` fires **after every turn that yields a field** (`FR-14`)
- [ ] Agent closes: doctor advice + *"I have informed {caregiver_name}"*
- [ ] 🚩 **T+8h GATE — hang up mid-intake. Partial record persists.** Test with Lane B

## Resume after drop (`J4`, `FR-19`–`FR-22`)

- [ ] `agent/prompts/3c-mode-resume.md`
- [ ] `resume_session` returns `fields_so_far` + `missing`
- [ ] Opening **states what it already has** (`FR-21`) —
      *"I have you, Sharma-ji — chest tightness, about four minutes ago.
      I still need to know whether your breathing feels normal."*
- [ ] Continues from `missing[0]`. **Nothing is re-asked** (`FR-20`)
- [ ] Second call from the same number within the window **resumes**, does not duplicate
- [ ] Cross-direction continuity: a morning outbound observation is referenced on the
      evening inbound call (`FR-22`)

- [ ] 🚩 **T+11.5h GATE — full inbound → intake → escalation → handoff link opens on a second phone**

---

# PROOF — "it survives a hostile judge"
### T+11.5 → T+17.5 (06:00 → 12:00) · Gate: feature freeze at 12:00

## Latency (`NFR-1` ≤1.2s p50, ≤2.0s p95)

- [ ] Measure p50 and p95, end of parent speech → start of agent speech
- [ ] Apply levers **in this order** if over budget:
  1. [ ] Trim `get_care_context` payload — 3 observations, not 10
  2. [ ] Preload context via dynamic variables so no tool fires on turn one
  3. [ ] Make `upsert_intake` fire-and-forget where the response isn't needed
  4. [ ] Drop to a lower-latency voice
- [ ] ❌ **Never** solve latency by batching `upsert_intake` to call end.
      That trades the demo's best moment for 200ms

## Edge cases (`PRD §13`)

- [ ] Someone other than the parent calls — field 1 captures identity + relationship,
      everything else unchanged
- [ ] Parent switches language mid-sentence — followed, no clarification round-trip
- [ ] Parent says something the record contradicts — captured verbatim, discrepancy
      flagged, **not adjudicated**
- [ ] *"Should I take a double dose?"* — refuse, redirect to doctor, escalate (`SR-1`)
- [ ] Parent asks the agent to stop calling — honoured, logged, caregiver notified (`SR-5`)
- [ ] Silence ≥6s → one gentle re-prompt → graceful close
- [ ] Tool returns `{ok:false}` → scripted fallback, conversation continues, **never silence**

## Hygiene

- [ ] All prompts mirrored into `agent/prompts/*.md` and **committed**.
      *A prompt change is the most likely cause of a regression between a working run
      and a recorded run. If it isn't in git, the regression is unfindable at 3 AM*
- [ ] Turn count instrumented — metric `S7`, target ≤7 parent turns to full intake
- [ ] No credentials in any commit
- [ ] Rotate the ElevenLabs and Twilio keys **after the event**

## Support Lane D's cold runs

- [ ] Present but silent during R1/R2/R3 — **no builder intervention** is a scoring
      requirement, not a preference
- [ ] Zero safety FAILs across all recorded runs (`S5`)
