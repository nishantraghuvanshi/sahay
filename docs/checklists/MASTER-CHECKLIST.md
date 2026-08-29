# KINVOX — MASTER BUILD CHECKLIST
### Everything, in clock order. One file. 24 hours.

**Legend** — `[A]` Voice · `[B]` API · `[C]` App · `[D]` Evidence · `[ALL]` everyone
🚩 hard gate · 🔑 high-leverage, do not skip · ⚠️ can disqualify or invalidate a run

**How to use:** find the current time window, do your lane's items.
Gates are pass/fail — miss one, **cut scope, do not extend**.

| Owner | Name |
|---|---|
| Lane A — Voice *(critical path)* | |
| Lane B — Memory & API | |
| Lane C — App & handoff | |
| Lane D — Evidence & revenue | |
| 5th person, if any → **second body on Lane A** | |

---

# § 0 · PRE-KICKOFF — 17:00 → 18:30

- [ ] `[ALL]` ⚠️ Ask a mentor at check-in, verbatim:
      *"I'm a founder — pre-product in elder-care voice AI. No codebase, no launch, never
      pitched. Prior work is market research and a no-code voice agent I won't touch. If I
      build from zero today in the same domain, is that clean? Does it change if I reuse
      the brand name?"*
- [ ] `[ALL]` **Get a name.** Write down who answered and what they said
- [ ] `[ALL]` ⚠️ Confirm: has any of this been **pitched or demoed at another event?**
      (hard disqualifier, no borderline path)
- [ ] `[ALL]` ⚠️ **Move `docs/Archive 2/` out of the project directory.** It holds a working
      codebase for the same use case **and a `.env` with live Sarvam + Groq keys.**
      Gitignoring is not enough — one `git add -f` ships a disqualifier and two live
      credentials into a public repo
- [x] `[ALL]` Product name — **not Voxikin**. Settled 30 Aug: **Kinvox**
- [ ] `[D]` Charge phones. Two recording devices. A second physical handset for the handoff shot

---

# § 1 · T+0 → T+1 · 18:30 → 19:30 — ALL FOUR TOGETHER
### No feature code until this block closes

## The five verifications

- [ ] `[ALL]` **V1 — what exactly is "the Hive stack"?** Building on another stack is a
      listed disqualifier. **Blocking**
- [ ] `[ALL]` 🔑 **V1 mitigation, propose it rather than wait:** the Hive stack is a unified
      model router (Claude 3.5 Sonnet / Llama-3-70b / Gemma-3 / DeepSeek-R1). ElevenLabs
      Agents supports a **custom LLM endpoint** — point it at the Hive router. Voice
      transport stays ElevenLabs, the reasoning layer runs on-stack
- [ ] `[ALL]` **V2 — is Emergent required or merely sponsored?** If required, it constrains the backend
- [ ] `[A]` **V3 — exact inbound caller-ID variable** ElevenLabs exposes on a Twilio inbound call
- [ ] `[D]` **V4 — live rates**, screenshotted with a timestamp: ElevenLabs ₹/min ·
      Twilio US→IN ₹/min · LLM cost per call
- [ ] `[A]` **V5 — can the agent take dynamic variables at call start?**
      Determines preload vs. a turn-zero tool call

## Repo

- [ ] `[ALL]` ⚠️ **First commit after 18:00.** Repo does not exist before T-0
- [ ] `[ALL]` `.gitignore` with `.env` **in commit 1**
- [ ] `[ALL]` Skeleton: `/agent /api /app /handoff /scripts /evidence /docs`
- [ ] `[ALL]` `.env.example` — every key named, no values
- [ ] `[ALL]` Branches `lane-a` … `lane-d`
- [ ] `[ALL]` `README.md` stub — build instructions are a submission requirement

## 🚩 GATE T+1h — FREEZE THE TOOL CONTRACT

> Nothing in this build matters as much as freezing this on time.
> Once frozen it is **not renegotiated**.

- [ ] `[ALL]` All 7 request/response shapes written into `agent/tools.json`
- [ ] `[ALL]` Conventions: `POST` · JSON · Bearer auth · 3s hard timeout
- [ ] `[ALL]` ⚠️ **Always HTTP 200.** Errors are `{"ok":false,"error":"…"}`. A non-2xx
      stalls the agent and the parent hears silence
- [ ] `[ALL]` Idempotency keys named: `log_dose` on `(medication_id, slot_time)`,
      `upsert_intake` on `session_id`

## Decide the three ambiguities the docs leave open

- [ ] `[ALL]` **Pricing page + checkout → Lane D**, entirely
      *(IDEA_SCOPE §3 says C · TRD §1.2 says D · TRD §13 says C)*
- [ ] `[ALL]` **Twilio purchase → D. Routing → A.**
- [ ] `[ALL]` **Appointment reminders** — cut in PRD §14, sold in the Care+ tier in §15.
      Mark "coming soon" or delete from the tier
- [ ] `[ALL]` 🔑 **Agree the Impact number.** The rubric grades Impact by how far a metric
      moves (<5%=L2 · 5–10%=L3 · 10–30%=L4 · >30%=L5). The PRD names no delta. Without
      one you score L2 on a parameter your research already earns L4 on

---

# § 2 · T+1 → T+5.5 · 19:30 → 00:00 — **MVP**
### "It runs"

## `[B]` First 30 minutes — unblock everyone else

- [ ] 🔑 **Ship the mock API before anything else.** Canned contract-shaped responses,
      no DB, no logic. A points its tools at it, C points its fetches at it.
      **From this moment nobody waits on Lane B**
- [ ] Publish the mock base URL in the team channel

## `[B]` Schema

- [ ] `caregivers` · `patients` · `medications` · `call_sessions` · `dose_events` ·
      `observations` · `intake_records` · `escalations` · `handoffs` · `subscriptions`
- [ ] `patients(phone_e164)` **unique** — inbound resolution, 500ms budget
- [ ] `call_sessions(patient_id, status)` **partial** on `active|dropped` — resume must not scan history
- [ ] `dose_events(medication_id, slot_time)` **unique** — a retry must not double-log
- [ ] `observations(patient_id, created_at DESC)` — context returns the 3 most recent
- [ ] `patients.schedule_signed_off_at` — NULL means no calls allowed
- [ ] `patients.calls_paused` — parent asked to stop
- [ ] `intake_records.priority_rule` — never empty

## `[B]` Seed data — first real deliverable, everyone builds on it

- [ ] 1 caregiver — a team member's phone
- [ ] 1 patient — a second team member's phone, `hi-IN`, age 68, conditions
      `{hypertension, type-2 diabetes}`, allergies `{sulfa}`, doctor, address, **signed off**
- [ ] 3 medications — one morning, one evening, one `is_priority`
- [ ] 5 historical `dose_events` over 2 days, **one missed**
- [ ] 2 historical `observations`, one `watch` mentioning knee pain
- [ ] Loader idempotent
- [ ] ⚠️ Team members' own phones only, with consent. No third-party data

## `[B]` Pure functions — zero deps, build in parallel with the schema

- [ ] **`assign_priority(fields, patient) → (priority, rule_text)`** — pure, **no model call ever**
- [ ] Rules **ordered**, first match wins and is the one cited
- [ ] `rule_text` never empty, stored literally, **never names a condition or diagnosis**
- [ ] **Red-flag lexicon** → `none|watch|red`, matching Hindi, English, **and code-switched forms**
      — `red`: chest pain / *seene mein dard*, breathlessness / *saans nahi aa rahi*,
      unresponsive, *behosh*, sudden one-sided weakness, bleeding
      — `watch`: dizziness / *chakkar*, persistent vomiting, new severe pain, fever 3+ days
- [ ] ⚠️ The lexicon assigns **severity only. Never meaning**
- [ ] **Completeness calculator** → `{completeness, captured[], missing[]}` over 12 fields
- [ ] **Safety scorer**, deterministic pass → `{pass, findings[]}`
- [ ] **Escalation matrix resolver** → `{level, channels[], needs_handoff}`
- [ ] **Handoff token** — ≥32 random URL-safe bytes, 24h expiry, mint + verify

## `[B]` The seven tools

- [ ] `identify_caller` — unknown → `{ok:false,"not_found"}`
- [ ] `get_care_context` — **3 most recent observations only**
- [ ] `log_dose` — idempotent
- [ ] `log_observation` — text stored **verbatim, never paraphrased**
- [ ] 🔑 **`upsert_intake`** — called on **every turn that yields a field**, idempotent,
      returns completeness / captured / missing / priority / rule
- [ ] ⚠️ *If this only fires at call end, a dropped call loses everything, FR-14 and FR-20
      both fail. This is the single most likely way the build breaks*
- [ ] `escalate` — returns channel, recipient, `handoff_url`
- [ ] `resume_session` — returns `fields_so_far` + `missing`, or `no_open_session`

## `[A]` Telephony

- [ ] Purchased number confirmed to do **inbound and outbound**
- [ ] Outbound to India verified from the US number *(Indian carriers only accept
      international origination; an Indian DID needs a regulatory bundle, up to 3 business days)*
- [ ] Twilio native integration in the ElevenLabs dashboard: label + number + SID + auth token
- [ ] Agent assigned to the number
- [ ] Twilio webhook signature validated
- [ ] 🔑 **Place one throwaway call before writing a single prompt.**
      If telephony is broken, nothing downstream matters

## `[A]` Agent shell + prompt blocks

- [ ] **One agent, two entry modes.** Not two agents — a guardrail in two places drifts
- [ ] Flash v2.5 realtime tier · Hindi voice · silence timeout 6s
- [ ] ⚠️ Every prompt **written fresh on the floor.** Do not copy from any prior file
- [ ] `1-identity.md` — who the agent is, who set it up, why it is calling
- [ ] `2-voice-rules.md` — one question per turn · <15 words · `Sharma-ji` never
      first-name-only · Hindi/English mixed within a sentence · **never a keypad press** ·
      confirm back before writing a clinical field · never say a number, dose, or medical
      term the record does not contain
- [ ] `3a-mode-outbound-dose.md`
- [ ] `5-guardrails.md` — **written before any mode except outbound, ordered LAST in context**
  - [ ] Never a diagnosis, never say what a symptom means
  - [ ] Never a dose instruction, dose change, or treatment advice
  - [ ] ⚠️ Never say help / ambulance / doctor has been sent. **You cannot send anyone**
  - [ ] On a red flag, exactly three things in order: acknowledge → *"please contact your
        doctor now"* → *"I am informing {caregiver_name} right now"* → call `escalate`
  - [ ] Never state a medicine, dose, condition, or allergy not in this call's context
  - [ ] If you don't know, say so. **Never fill a gap with a guess**

## `[A]` Tools + fallbacks

- [ ] All 7 registered, **pointed at the mock API**
- [ ] Filler line while waiting (*"one moment"*) — never dead air
- [ ] `identify_caller` fails → *"Let me take your details fresh. Can you tell me your name?"*
- [ ] `get_care_context` fails → *"I'll take everything from you directly."*
- [ ] `upsert_intake` fails → *say nothing, continue collecting, retry next turn*
- [ ] 🔑 `escalate` fails → *"Please call your doctor now, and please also call
      {caregiver_name} directly."* **If the machine can't reach the caregiver, the human must be told to**

## `[A]` Outbound flow

- [ ] Greets by name with medicine and slot preloaded — **zero clarifying questions about identity**
- [ ] Taken → `log_dose(confirmed)` · Not yet → offer callback → `deferred` · Cannot → reason → `missed`
- [ ] One wellbeing question, **verbatim** → `log_observation`
- [ ] Red flag → SR-2 sequence, no interpretation → `escalate`
- [ ] **T+4h — Hindi voice listen test.** Poor quality → switch voice now. English only as last resort

## `[C]` Scaffold + first screens

- [ ] Emergent project created, credits requested (300 / 600 on request)
- [ ] 🚩 **T+3h CHECKPOINT — is the generated code usable?** If not, stop and hand-build a
      minimal read-only app. Do not spend the night fighting the generator
- [ ] Note which DB Emergent provisions — tell Lane B immediately. **Do not fight the generator**
- [ ] `mock-api.json` from the contract response shapes
- [ ] **Single config constant for the API base URL** — one line to swap at integration
- [ ] **Care record view** — identity, conditions, allergies, doctor, medicines with
      priority flag visible, meal times
- [ ] **Dose history** — per-slot status colour-coded, reason text, reconciles with `dose_events`

## `[D]` Money live

- [ ] Buy the Twilio number *(D purchases, A routes)*
- [ ] Pricing page live: Trial free 7d · **Care ₹499/mo** · **Care+ ₹999/mo**
- [ ] ⚠️ Resolve the appointment-reminders line on Care+
- [ ] UPI payment link live, tested with a ₹1 transaction to yourself
- [ ] Successful payment writes a `subscriptions` row visible in the app
- [ ] Landing copy — the parent installs nothing, the child pays

## 🚩 GATE T+5h · 23:30
- [ ] **One outbound call completes and a `dose_event` row exists**

---

# § 3 · T+5.5 → T+11.5 · 00:00 → 06:00 — **CORE**
### "It's the product." If you're behind, cut from PROOF — never from here.

## `[A]` Caller resolution — build the fallback FIRST

> Building the automatic path first and discovering at 2 AM that the variable is absent
> is the worst-case ordering.

- [ ] 🔑 **Ask-for-number fallback** — unconditional, always works
      *"Can you tell me the phone number of the person this is about?"* → `identify_caller`
      → everything downstream identical
- [ ] **Only then** wire the automatic caller-ID path using the V3 variable
- [ ] Resolution completes **before the first agent turn** (≤500ms)
- [ ] Unknown number → graceful, asks for the number, **never invents a record**

## `[A]` Inbound intake

- [ ] `3b-mode-inbound-intake.md`
- [ ] `identify_caller` → `resume_session` → `get_care_context`, all **before the agent speaks**
- [ ] 🔑 **Opening names ≥3 record facts unprompted** —
      *"Hello Sharma-ji — is this about the chest discomfort you mentioned this morning?"*
- [ ] Asks **only the 6 unknown fields**, one per turn:
      caller identity+relationship · chief complaint verbatim · onset · responsive ·
      breathing · location (**confirm only**)
- [ ] Never re-asks the 6 inherited: patient identity · medicines · allergies ·
      conditions · callback number · priority
- [ ] `upsert_intake` fires **after every turn that yields a field**
- [ ] Closes with doctor advice + *"I have informed {caregiver_name}"*

## `[A]` Resume after drop

- [ ] `3c-mode-resume.md`
- [ ] Opening **states what it already has** — *"I have you, Sharma-ji — chest tightness,
      about four minutes ago. I still need to know whether your breathing feels normal."*
- [ ] Continues from `missing[0]`. **Nothing is re-asked**
- [ ] Second call from the same number within the window **resumes**, no duplicate
- [ ] Cross-direction: a morning outbound observation referenced on an evening inbound call

## `[B]` Session state machine

- [ ] `active` → `dropped`/`completed` → `scored`; `dropped` → `abandoned`
- [ ] `resumable_until = started_at + 15 min`
- [ ] `resumes_session_id` links new session to old
- [ ] **Invariant: at most one `active` session per patient**

## `[B]` Escalation service

- [ ] Build message → mint token if P1/P2 → send → record `delivery_status`
- [ ] WhatsApp → **SMS fallback** → on P1 **also place a voice call**
- [ ] Message names **both** parent and caregiver
- [ ] Message contains the **rule text**, not just the letter
- [ ] Delivered within **30s** of the triggering turn
- [ ] ⚠️ Failed send written with `delivery_status`, **never silently dropped**
- [ ] ⚠️ Never states that help has been dispatched

## `[B]` Handoff + scheduler + scorer

- [ ] `/h/{token}` — token **is** the auth, no login, 24h expiry, `viewed_at` stamped
- [ ] Scheduler every 60s; idempotent on `(medication_id, slot_time)`;
      **never dials over an active session — queue**; deferred re-queue;
      no answer → `no_answer`; skip if not signed off; skip if paused
- [ ] 🔑 **Authenticated "fire this slot now" endpoint.** You cannot wait for 08:30 on
      camera. **Do not show it in the video**
- [ ] Safety scorer on **every** completed session — deterministic pass, then one LLM
      judge pass. **Both must pass.** Writes `safety_pass` + `safety_findings`
- [ ] ⚠️ **Any FAIL invalidates that run**

## `[C]` The screens that carry the score

- [ ] **Observations timeline** — **verbatim**, timestamped, severity chip, newest first
- [ ] 🔑 **Escalation feed rendering the literal rule text** —
      `rule: chest complaint with age over 40`, **not just `P1`**.
      *This is the answer when a judge asks "how do you know it's a P1?"*
- [ ] **Onboarding, four steps** (`WIREFRAMES §4`) — auth (phone → OTP → email → OTP,
      **no social login**) · add parent (E.164, language, clinical context) · prescription
      + schedule · **consent**. At most one priority medicine; meal times
- [ ] 🔑 **Explicit schedule sign-off gate** — scheduling without sign-off is **refused**, not warned
- [ ] 🔑 **Second gate: the intro call.** One call, no medicines, before anything else —
      dose calls start only after the parent agrees on it. Three mandatory caregiver
      consents (parent knows · recorded & transcribed · never gives medical advice)
- [ ] **Medicine editor** — plain-language change diff + **mandatory doctor-advice
      attestation** before changes save
- [ ] **Handoff view** `/h/{token}` — no login, read-only, **one phone screen, no scrolling
      for the P1 fields**, renders all twelve including **priority + rule text**
- [ ] Copy-link action; `viewed_at` shown back to the caregiver
- [ ] Expired/invalid token → clean message, never a stack trace

## `[D]` Scripts and buyers

- [ ] **R1** — chest tightness, 20 min onset, responsive, breathing normal, at home
      → 12/12 · **P1** *rule: chest complaint with age over 40* · escalation · handoff link
- [ ] **R2** — a **neighbour** calls about a fall; responsive, breathing normal, confused
      → 12/12 · **P2** *rule: acute onset with red-flag symptom* · field 1 captures the neighbour
- [ ] **R3** — R1 but **hang up after field 4**, redial after 60s
      → resume with **zero questions repeated**, final 12/12
- [ ] Ground truth for all 12 fields written **before** each run
- [ ] Scoring sheet built: captured · correct · inherited (should be 6) · turns (≤7) ·
      priority vs expected · rule text · escalation latency · safety verdict · intervention
- [ ] Post the teaser

## 🚩 GATE T+8h · 02:30
- [ ] `[A]`+`[B]` **Hang up mid-intake. The partial record persists.** *The FR-14 test*

## 🚩 GATE T+11.5h · 06:00
- [ ] **Full inbound → intake → escalation → handoff link opens on a second phone**
- [ ] *If this fails, drop resume-after-drop and protect the rest*

---

# § 4 · T+11.5 → T+17.5 · 06:00 → 12:00 — **PROOF**
### "It survives a hostile judge"

## `[A]` Latency — target ≤1.2s p50, ≤2.0s p95

- [ ] Measure p50 and p95, end of parent speech → start of agent speech
- [ ] Levers **in this order**: trim context payload to 3 observations → preload via
      dynamic variables → make `upsert_intake` fire-and-forget where the response isn't
      needed → drop to a lower-latency voice
- [ ] ⚠️ **Never** batch `upsert_intake` to call end. That trades the demo's best moment for 200ms

## `[A]` Edge cases

- [ ] Someone other than the parent calls — field 1 captures identity + relationship
- [ ] Language switch mid-sentence — followed, no clarification round-trip
- [ ] Record contradicted — captured verbatim, discrepancy flagged, **not adjudicated**
- [ ] *"Should I take a double dose?"* — refuse, redirect to doctor, escalate
- [ ] Parent asks the agent to stop calling — honoured, logged, caregiver notified
- [ ] Silence ≥6s → one gentle re-prompt → graceful close
- [ ] Tool returns `{ok:false}` → scripted fallback, conversation continues, **never silence**
- [ ] 🔑 All prompts mirrored into `agent/prompts/*.md` and **committed**.
      *A prompt change is the likeliest cause of a regression between a working run and a
      recorded run. If it isn't in git, the regression is unfindable at 3 AM*

## `[B]` Tests

- [ ] `assign_priority` — one test **per rule branch**
- [ ] `assign_priority` **ordering** — a case matching P1 and P2 returns the **P1** rule
- [ ] `upsert_intake` idempotency — same field twice does not duplicate
- [ ] `log_dose` idempotency on `(medication_id, slot_time)`
- [ ] Resume boundary — **14 min resumes, 16 min does not**
- [ ] Safety scorer — one crafted FAIL transcript **per pattern**
- [ ] Every tool returns its documented shape under 3s

## `[B]` Deploy + observe

- [ ] Care API on **public HTTPS** — ElevenLabs must reach it
- [ ] Structured log per tool call: name, session id, latency, ok/fail
- [ ] **Tool p95 printed to console every 5 min**
- [ ] 🔑 **Instrument turns-to-complete-intake.** It is metric S7, it proves inheritance
      is real, and it **cannot be reconstructed after the fact**
- [ ] Never log full phone numbers or transcript bodies — log ids only

## `[C]` Integration + mobile + deploy

- [ ] Swap base URL mock → real API; re-verify every screen against live data
- [ ] Empty states (no doses, no observations, no escalations)
- [ ] Error states — API unreachable shows a message, never a blank screen
- [ ] 🔑 **Handoff view tested on a real handset**, not a browser resize
- [ ] Load the live URL on a phone over **mobile data**, not office wifi
- [ ] Live public URL deployed
- [ ] 🔑 Screens legible in a screen recording. **The record visibly updating during a
      call is the shot that carries the video for a judge watching with the sound off**
- [ ] Nothing on screen reveals the "fire slot now" trigger. No lorem ipsum, no `TODO`

## `[D]` Record and score — this is the scored artifact

- [ ] Recruit three people **who did not build this**
- [ ] ⚠️ **Cold means:** a different person places the call, reading a script they have
      not rehearsed, **no builder touching a keyboard**. Recorded end to end
- [ ] Record R1 · Record R2 · Record R3 (including the hang-up and redial)
- [ ] Score all three against ground truth
- [ ] 🚩 **S1 ≥ 0.85** · 🚩 **zero safety FAILs** · 🚩 **zero builder intervention**
- [ ] ⚠️ A safety FAIL makes that run **invalid** — re-run it
- [ ] Recordings, transcripts, filled sheet → `/evidence`
- [ ] **Unit economics** — `COGS = (ElevenLabs ₹/min × avg_min) + (Twilio ₹/min × avg_min)
      + LLM tokens`; avg minutes **measured from R1–R3**; Care tier = 62 calls/month;
      `margin = (499 − COGS × 62) ÷ 499`
- [ ] ⚠️ **Do not state a margin that was not measured.** *"What does a call cost you?"*
      is the most likely Revenue challenge
- [ ] Start selling

## 🚩 GATE T+14h · 08:30
- [ ] **R1 passes cold**

## 🚩 GATE T+17.5h · 12:00 — FEATURE FREEZE, ABSOLUTE
- [ ] All three runs recorded and scored
- [ ] From here: **demo-blocking bugs only**

---

# § 5 · T+17.5 → T+20.5 · 12:00 → 15:00 — VIDEO & SALE

## `[A]` `[B]` `[C]` — demo-blocking bugs only. Nothing else.

## `[D]` The video — 3 minutes, one unbroken take for the demo section

> The handbook prescribes 30s context / 30s workflow / 2min live. That is written for the
> **top-3 stage slot**. For the submission video, **front-load the working product** —
> a judge on entry #17 of 30 decides in the first twenty seconds.

- [ ] **0–20s** — cold open on the hero moment, no setup. Parent dials. Agent:
      *"Hello Sharma-ji — is this about the chest discomfort you mentioned this morning?"*
- [ ] **20–45s** — context. 149M Indians 60+ · 36% with a migrant child ·
      medicines-on-time is the #1 stated worry
- [ ] **45s–2:30** — the full loop, **one take**: outbound dose call → record updates on
      screen → inbound inherits it → 12 fields fill → priority **with the rule string
      visible** → caregiver notified **by name** → **drop the call, redial, it resumes**
- [ ] **2:30–2:45** — the three cold runs side by side with the accuracy number
- [ ] **2:45–3:00** — the real payment confirmation. **Close on that, not on architecture**
- [ ] 🔑 **Watch it once with the sound off.** The hero moment is audio; the record
      updating, the rule string, and the handoff link opening on a second phone carry it visually
- [ ] Nothing reveals the manual trigger

## `[D]` Close the sale

- [ ] 🚩 **≥1 real payment received** — this is Revenue L5
- [ ] ⚠️ Sell to someone **genuinely** the ICP. Terms clause 09 permits **contact checks
      with your signups** — a favour-payment from a friend who isn't the customer is a
      challenge you lose
- [ ] Payment confirmation screenshotted; subscription row visible in the app

## 🚩 GATE T+20.5h · 15:00
- [ ] **Video locked**

---

# § 6 · T+20.5 → T+22.5 · 15:00 → 17:00 — FREEZE & PUBLISH

- [ ] `[A]` `[B]` Freeze. Write your section of the README
- [ ] `[C]` Freeze. Live URL deployed and loading
- [ ] `[D]` Post on LinkedIn / X / Instagram with a real narrative hook
- [ ] `[D]` **Screenshot post performance** — impressions, likes, reshares, comments → `/evidence`
- [ ] `[D]` `README.md` — **working build instructions**
- [ ] `[D]` `docs/GTM.md` — go-to-market brief
- [ ] `[D]` Unit-economics table in `/evidence`
- [ ] `[D]` ⚠️ **Borderline-starting-point note, accurately worded:**
      > *Borderline starting point: I am a founder in elder-care voice AI. A prior codebase
      > exists for a related use case; it was not used, opened, or shown. This is a
      > from-zero build. No prior code, agent config, product, or data was used or shown.*
- [ ] `[ALL]` ⚠️ **No credential in any commit.** The repo is public at submission
- [ ] `[ALL]` ⚠️ **Every row in `/evidence` from a real call.** No seeded intake records,
      no fabricated dose events, no invented payment. *A padded DB is a zeroed parameter,
      not a rounding error*

---

# § 7 · T+22.5 → T+23.5 · 17:00 → 18:00 — SUBMIT

> ⚠️ The handbook window is **17:30–18:00**, hard deadline 18:00.
> **Be done by 17:30.** Late submissions are not scored.

- [ ] Public GitHub repo URL + build instructions
- [ ] Live product URL **and** the 3-minute recording — ship both
- [ ] Virality screenshots
- [ ] GTM brief
- [ ] Borderline-starting-point note
- [ ] `[ALL]` Submitted. Confirmation captured

---

# RELEASE CRITERIA — ship only if all hold

- [ ] Three cold runs recorded · **≥85% field accuracy** · **zero safety failures**
- [ ] Inbound opening names **≥3 record facts**, unprompted, on camera
- [ ] **Resume-after-drop** demonstrated in one unbroken take
- [ ] Escalation **naming the caregiver**, delivered on camera
- [ ] Handoff link opened on a **second physical device** on camera
- [ ] **At least one real payment** received and shown
- [ ] Unit-economics table filled with **rates pulled that day**
- [ ] Public repo with working build instructions
- [ ] Borderline-starting-point note included

---

# THE FIVE THINGS THAT KILL THIS BUILD

1. **`upsert_intake` batching to call end.** Kills resume, kills Memory L5, kills the best
   moment in the video. **Write every turn.**
2. **Caller ID not exposed as expected.** Build the ask-for-number fallback *first*.
3. **A safety violation on a recorded run.** Any FAIL invalidates it. Score every transcript.
4. **Nobody owning the video.** Only the top 3 demo live. For everyone else the recording
   *is* the product.
5. **A padded database.** They perform spot checks. Every row from a real call, or the
   parameter zeroes.
