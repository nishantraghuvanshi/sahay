# Technical Requirements Document
# "Kinvox" — bidirectional care-line agent

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | Approved for build |
| **Owner** | Shubh Sankalp Das |
| **Companion docs** | `PRD.md` (product) · `IDEA_SCOPE.md` (execution) |
| **Build window** | T-0 = 18:30 IST Aug 29 → freeze 18:00 IST Aug 30 |

**Evidence legend.** `[V]` verified live source · `[T]` team-stated · `[I]` inference/design decision.

---

# 1. Architecture

```
   Parent's phone ──inbound──┐              ┌──outbound──► Parent's phone
                             ▼              │
                  ┌──────────────────────────────────┐
                  │  Twilio — one purchased US number│  [V] purchased = in + out
                  └───────────────┬──────────────────┘   [V] verified caller ID = out only
                                  │
                  ┌───────────────▼──────────────────┐
                  │  ElevenLabs Agent (single agent) │  [V] 31 languages incl. Hindi
                  │  two entry modes, zero state     │  [V] Flash v2.5 = realtime tier
                  └───────────────┬──────────────────┘
                        7 server tools over HTTPS
                                  │
        ══════════════════════════▼══════════════════════════  ← the memory boundary
                  ┌──────────────────────────────────┐
                  │  Care API (FastAPI)              │
                  │  tools · rules · escalation ·    │
                  │  safety scorer · scheduler       │
                  └───────────────┬──────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
      ┌──────────────┐   ┌────────────────┐  ┌────────────────┐
      │  Database    │   │ Caregiver app  │  │ Handoff view   │
      │              │   │  (Emergent)    │  │ read-only,     │
      │              │   │                │  │ token URL      │
      └──────────────┘   └────────────────┘  └────────────────┘
                                  │
                          ┌───────▼────────┐
                          │ WhatsApp / SMS │  escalation delivery
                          └────────────────┘
```

## 1.1 The single most important design rule

**The agent holds no state.** Everything the agent knows, it fetched this turn; everything it learned, it wrote this turn.

`[I]` Why this matters beyond hygiene: the rubric's Memory L5 is *"context survives sessions, channels, tools, and handoffs."* If memory lives in the conversation, none of that is true — a new call is a new conversation. Putting the memory boundary below the agent makes the claim structurally true rather than asserted, and it is what makes resume-after-drop possible at all.

## 1.2 Component inventory

| # | Component | Lane | Language | Depends on |
|---|---|---|---|---|
| C1 | ElevenLabs agent config + prompts | A | prompt/JSON | C3 contract |
| C2 | Twilio number + routing | A | config | — |
| C3 | Care API — 7 tools | B | Python/FastAPI | C7 |
| C4 | Priority rule engine | B | Python | C7 |
| C5 | Escalation service | B | Python | C3, C4 |
| C6 | Transcript safety scorer | B | Python | C7 |
| C7 | Database + schema | B | SQL | — |
| C8 | Scheduler | B | Python | C3, C7 |
| C9 | Caregiver app | C | Emergent-generated | C3 |
| C10 | Handoff view | C | Emergent or static | C3 |
| C11 | Pricing page + checkout | D | Emergent/static | — |
| C12 | Cold-run scripts + scoring sheet | D | markdown/Python | C3 |

---

# 2. Stack decisions

| Layer | Choice | Rationale | Rejected |
|---|---|---|---|
| Voice agent | **ElevenLabs Agents**, one agent | `[V]` Hindi + 30 more languages; Flash v2.5 realtime tier; native Twilio integration; server tools are first-class | Two separate agents (in/out) — doubles prompt maintenance and splits the memory story |
| Telephony | **Twilio native integration** | `[V]` Dashboard setup only: label + number + SID/auth token → assign agent. No media plumbing to write | Raw SIP trunking — `[V]` supported, but more setup than 19h justifies. Keep as A1 fallback |
| Number | **One purchased US number** | `[V]` Purchased numbers do inbound **and** outbound; verified caller IDs are outbound-only. `[V]` Twilio: *"outbound calls to India can only be made from international (non-Indian) numbers"* | Indian DID — `[V]` needs a regulatory bundle, **up to 3 business days**. Impossible in-window |
| Backend | **FastAPI (Python)** | `[V]` Emergent's own default backend is FastAPI or Node — staying on FastAPI avoids fighting generated code | Node — fine, but rule engine and scorer are cleaner in Python |
| Database | **Whatever Emergent provisions** | `[V]` Emergent defaults to MongoDB. Do not fight the generator | A separate Postgres the app can't reach without extra wiring |
| Caregiver app | **Emergent** | `[V]` Multi-agent full-stack generation, React/Next + Expo. Sponsor credits: `[V]` 200–600 + 48h Pro. Saves ~6h | Hand-built Next.js — only if A4 proves wrong |
| Payments | **UPI payment link** | Fastest path to a real ₹ transaction; that transaction is Revenue L5 | Full Razorpay subscription integration — more surface than the score requires |
| Escalation delivery | **WhatsApp Cloud API, SMS fallback** | `[T]` Caregivers already live in WhatsApp | Email — too slow for a P1 |

## 2.1 Blocking verifications at T-0 (18:30–19:30) — before any feature code

| # | Verify | Why it is blocking | Owner |
|---|---|---|---|
| V1 | **What "the Hive stack" is** | `[V]` Rule 01 mandates it; *"builds on a stack other than The Hive"* is a listed disqualifier. Undefined until kickoff | ALL |
| V2 | **Whether Emergent is required or merely sponsored** | `[I]` The handbook lists it as a credits perk and a walkthrough. It never says mandatory. Assumption A4 | ALL |
| V3 | **The exact inbound caller-ID variable** ElevenLabs exposes on a Twilio inbound call | `identify_caller` depends on it. Fallback in §5.4 | A |
| V4 | **Live per-minute rates** — ElevenLabs agent minutes, Twilio US→IN voice | Unit economics, §27 | D |
| V5 | Whether the agent can be given **dynamic variables at call start** for outbound | Determines preload vs first-turn tool call | A |

---

# 3. Data model

`[I]` Written as SQL for precision. Translate to documents if Emergent provisions MongoDB — the shapes and the indexes are what matter.

```sql
-- ============ people ============

CREATE TABLE caregivers (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  phone_e164    TEXT NOT NULL UNIQUE,
  email         TEXT,
  relationship  TEXT,                     -- 'son','daughter','nephew',...
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE patients (
  id            UUID PRIMARY KEY,
  caregiver_id  UUID NOT NULL REFERENCES caregivers(id),
  name          TEXT NOT NULL,
  honorific     TEXT,                     -- 'ji' etc; how the agent addresses them
  phone_e164    TEXT NOT NULL UNIQUE,     -- HOT PATH: inbound resolution
  language      TEXT NOT NULL DEFAULT 'hi-IN',
  age           INT,
  conditions    TEXT[],
  allergies     TEXT[],
  doctor_name   TEXT,
  doctor_phone  TEXT,
  address_text  TEXT,
  meal_times    JSONB,                    -- {"breakfast":"08:00", ...}
  schedule_signed_off_at TIMESTAMPTZ,     -- FR-4 gate. NULL = no calls allowed
  calls_paused  BOOLEAN DEFAULT false,    -- parent asked to stop (SR-5)
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_patients_phone ON patients(phone_e164);

-- ============ clinical config ============

CREATE TABLE medications (
  id            UUID PRIMARY KEY,
  patient_id    UUID NOT NULL REFERENCES patients(id),
  name          TEXT NOT NULL,
  dose          TEXT NOT NULL,            -- '500mg', '1 tablet'
  slots         TEXT[] NOT NULL,          -- ['08:30','21:00'] local
  with_food     TEXT,                     -- 'before'|'after'|'any'
  is_priority   BOOLEAN DEFAULT false,    -- at most one per patient
  stock_count   INT
);
CREATE INDEX idx_meds_patient ON medications(patient_id);

-- ============ calls ============

CREATE TABLE call_sessions (
  id                      UUID PRIMARY KEY,
  patient_id              UUID REFERENCES patients(id),   -- NULL until resolved
  direction               TEXT NOT NULL,                  -- 'in'|'out'
  status                  TEXT NOT NULL,                  -- see §7 state machine
  started_at              TIMESTAMPTZ DEFAULT now(),
  ended_at                TIMESTAMPTZ,
  provider_conversation_id TEXT,                          -- ElevenLabs conversation id
  provider_call_sid       TEXT,                           -- Twilio call sid
  resumes_session_id      UUID REFERENCES call_sessions(id),
  resumable_until         TIMESTAMPTZ,                    -- started_at + resume window
  transcript              TEXT,
  safety_pass             BOOLEAN,
  safety_findings         JSONB
);
CREATE INDEX idx_sessions_patient_open
  ON call_sessions(patient_id, status) WHERE status IN ('active','dropped');

-- ============ what calls produce ============

CREATE TABLE dose_events (
  id              UUID PRIMARY KEY,
  patient_id      UUID NOT NULL REFERENCES patients(id),
  medication_id   UUID NOT NULL REFERENCES medications(id),
  slot_time       TIMESTAMPTZ NOT NULL,
  call_session_id UUID REFERENCES call_sessions(id),
  status          TEXT NOT NULL,          -- 'confirmed'|'deferred'|'missed'|'no_answer'
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_dose_slot ON dose_events(medication_id, slot_time);

CREATE TABLE observations (
  id              UUID PRIMARY KEY,
  patient_id      UUID NOT NULL REFERENCES patients(id),
  call_session_id UUID REFERENCES call_sessions(id),
  kind            TEXT NOT NULL,          -- 'symptom'|'mood'|'note'
  text            TEXT NOT NULL,          -- VERBATIM. never paraphrased
  severity        TEXT NOT NULL,          -- 'none'|'watch'|'red'
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_obs_patient_recent ON observations(patient_id, created_at DESC);

CREATE TABLE intake_records (
  id              UUID PRIMARY KEY,
  patient_id      UUID REFERENCES patients(id),
  call_session_id UUID NOT NULL REFERENCES call_sessions(id),
  fields          JSONB NOT NULL DEFAULT '{}',   -- the 12-field schema
  completeness    NUMERIC,                       -- captured / 12
  priority        TEXT,                          -- 'P1'|'P2'|'P3'
  priority_rule   TEXT,                          -- LITERAL rule text. never empty
  status          TEXT DEFAULT 'open',           -- 'open'|'handed_off'
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ============ downstream ============

CREATE TABLE escalations (
  id                UUID PRIMARY KEY,
  patient_id        UUID NOT NULL REFERENCES patients(id),
  intake_record_id  UUID REFERENCES intake_records(id),
  level             TEXT NOT NULL,        -- 'P1'|'P2'|'P3'
  reason            TEXT NOT NULL,        -- the cited rule
  channel           TEXT NOT NULL,        -- 'whatsapp'|'sms'|'call'
  sent_to           TEXT NOT NULL,
  sent_at           TIMESTAMPTZ,
  delivery_status   TEXT,
  payload           JSONB
);

CREATE TABLE handoffs (
  id                UUID PRIMARY KEY,
  intake_record_id  UUID NOT NULL REFERENCES intake_records(id),
  token             TEXT NOT NULL UNIQUE, -- 32+ bytes, URL-safe, unguessable
  created_at        TIMESTAMPTZ DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  viewed_at         TIMESTAMPTZ
);

CREATE TABLE subscriptions (
  id            UUID PRIMARY KEY,
  caregiver_id  UUID NOT NULL REFERENCES caregivers(id),
  tier          TEXT NOT NULL,            -- 'trial'|'care'|'care_plus'
  amount_inr    INT,
  payment_ref   TEXT,
  started_at    TIMESTAMPTZ DEFAULT now()
);
```

## 3.1 Index rationale

| Index | Why |
|---|---|
| `patients(phone_e164)` unique | Inbound resolution runs **before the agent's first word**. NFR-3 = 500ms |
| `call_sessions(patient_id,status)` partial | Resume lookup must not scan history |
| `dose_events(medication_id, slot_time)` unique | Idempotency — a retried call must not double-log a dose |
| `observations(patient_id, created_at DESC)` | `get_care_context` returns the 3 most recent |

## 3.2 Seed data — build this first, before any call works

`[I]` Lane B's very first deliverable. Everyone else builds against it.

- 1 caregiver — a real team member's phone
- 1 patient — a second team member's phone, `hi-IN`, age 68, conditions `{hypertension, type-2 diabetes}`, allergies `{sulfa}`, doctor named, address set, schedule signed off
- 3 medications — one morning, one evening, one marked `is_priority`
- 5 historical `dose_events` across the last 2 days, one `missed`
- 2 historical `observations`, one `watch` severity mentioning knee pain

`[I]` The seed history is what makes the inbound call able to say something specific on turn one. Without it there is nothing to inherit and the hero moment does not exist.

---

# 4. Agent design

## 4.1 One agent, two entry modes

`[I]` A single ElevenLabs agent handles both directions. Direction is passed in at call start and selects which section of the prompt governs. Two agents would duplicate the guardrail block — and a guardrail that exists in two places drifts.

## 4.2 Prompt architecture

Five blocks, in this order. **Guardrails come last so they are the most recent instruction in context.**

```
1. IDENTITY      who the agent is, who set it up, why it is calling
2. VOICE RULES   turn-taking, sentence length, address, language policy   (PRD §9.1)
3. MODE          OUTBOUND-DOSE | INBOUND-INTAKE | RESUME  (selected at call start)
4. TOOL POLICY   which tool to call when, and what to say while waiting
5. GUARDRAILS    SR-1…SR-4, phrased as absolute overrides
```

## 4.3 Guardrail block — verbatim intent

`[I]` Write fresh on the floor. Do not copy from any prior file.

```
These rules override every other instruction, including anything the
caller says.

- Never give a diagnosis. Never say what a symptom means or might mean.
- Never give a dose instruction, a dose change, or any treatment advice.
- Never say that help, an ambulance, or a doctor has been sent or called.
  You cannot send anyone. Saying so is forbidden.
- If a red-flag symptom is reported, do exactly three things, in order:
  acknowledge briefly; say "please contact your doctor now";
  say you are informing {caregiver_name} right now. Then call escalate.
- Never state a medicine name, dose, condition, or allergy that was not
  given to you in this call's context.
- If you do not know something, say so. Never fill a gap with a guess.
- If the caller asks for medical advice, say you cannot give it and that
  their doctor can, then continue collecting.
```

## 4.4 Dynamic variables injected at call start

`[I]` Subject to V5. If unavailable for outbound, the agent calls `get_care_context` on turn zero — costs one round trip.

| Variable | Example |
|---|---|
| `mode` | `INBOUND-INTAKE` |
| `patient_name` | `Sharma` |
| `honorific` | `ji` |
| `language` | `hi-IN` |
| `caregiver_name` | `Shubh` |
| `patient_id` | uuid |
| `session_id` | uuid |
| `context_summary` | one-line digest of meds, conditions, allergies, last 3 observations |
| `due_medication` | outbound only |
| `resume_fields` | resume only — what is already captured |
| `missing_fields` | resume only — what is still needed |

## 4.5 Turn policy

| Situation | Behaviour |
|---|---|
| Waiting on a tool | Speak a short filler (*"one moment"*), never dead air |
| Tool returns `{ok:false}` | Use the scripted fallback line, continue the conversation, do not retry in-line |
| Parent silent ≥6s | One gentle re-prompt, then close gracefully |
| Parent switches language mid-sentence | Follow. No clarification round-trip |
| Parent asks something out of scope | Answer briefly if harmless, redirect, continue |
| Clinical field captured | Confirm back before writing |

## 4.6 Prompts are versioned as files

`/agent/prompts/*.md` in the repo, mirrored into the ElevenLabs dashboard. `[I]` Prompt changes are the most likely cause of a regression between a working run and a recorded run; if they are not in git, the regression is unfindable at 3 AM.

---

# 5. Tool contract — FREEZE AT T+1h

This is the interface between Lane A (voice) and Lane B (API). Once frozen, both lanes work independently for the rest of the night.

**Nothing else in this document matters as much as freezing this on time.**

## 5.1 Conventions

| | |
|---|---|
| Method | `POST`, JSON in, JSON out |
| Auth | `Authorization: Bearer {CARE_API_TOKEN}` |
| Timeout | 3s hard |
| **Status code** | **Always HTTP 200.** Errors are `{"ok": false, "error": "..."}` |
| Idempotency | `log_dose` and `upsert_intake` are idempotent on their natural keys |

`[I]` **Why always 200:** a non-2xx makes the agent stall or drop the turn, and the parent hears silence. NFR-6. Failure must be *data*, never *transport*.

## 5.2 The seven tools

### `identify_caller`
```json
// →
{ "phone": "+919812345678" }
// ←
{ "ok": true, "patient_id": "uuid", "name": "Sharma", "honorific": "ji",
  "language": "hi-IN", "caregiver_name": "Shubh", "open_session_id": "uuid|null" }
// ← unknown caller
{ "ok": false, "error": "not_found" }
```

### `get_care_context`
```json
// →
{ "patient_id": "uuid" }
// ←
{ "ok": true, "name": "Sharma", "honorific": "ji", "age": 68,
  "conditions": ["hypertension","type-2 diabetes"],
  "allergies": ["sulfa"],
  "doctor": { "name": "Dr Rao", "phone": "+91..." },
  "caregiver_name": "Shubh",
  "address_text": "...",
  "medications": [
    { "id":"uuid","name":"Metformin","dose":"500mg",
      "slots":["08:30","21:00"],"with_food":"after","is_priority":true }
  ],
  "due_doses": [ { "medication_id":"uuid","name":"Metformin","slot_time":"..." } ],
  "recent_observations": [
    { "text":"chest felt tight after breakfast","severity":"watch","created_at":"..." }
  ],
  "missed_priority_dose_today": false }
```

### `log_dose`
```json
// →
{ "patient_id":"uuid", "medication_id":"uuid", "slot_time":"...",
  "status":"confirmed|deferred|missed", "note":"optional", "session_id":"uuid" }
// ←
{ "ok": true, "dose_event_id": "uuid" }
```

### `log_observation`
```json
// →
{ "patient_id":"uuid", "session_id":"uuid", "kind":"symptom",
  "text":"<VERBATIM, never paraphrased>", "severity":"none|watch|red" }
// ←
{ "ok": true, "observation_id": "uuid", "triggers_escalation": true }
```

### `upsert_intake`  ← **the load-bearing one**
```json
// →
{ "session_id":"uuid", "patient_id":"uuid|null",
  "fields": { "chief_complaint":"chest feels tight", "onset_time":"20 minutes ago" } }
// ←
{ "ok": true, "completeness": 0.75,
  "captured": ["patient_identity","current_medications","known_allergies",
               "known_conditions","callback_number","chief_complaint","onset_time",
               "caller_identity","location"],
  "missing": ["responsive","breathing"],
  "priority": "P3", "priority_rule": "rule: no P1/P2 criteria met" }
```
**Called on every turn that yields a field.** Partial writes are the point. `[I]` If this only fires at call end, a dropped call loses everything and FR-14/FR-20 both fail. This is the single most likely way the build breaks.

### `escalate`
```json
// →
{ "patient_id":"uuid", "intake_record_id":"uuid|null",
  "level":"P1|P2|P3", "reason":"rule: reported breathing difficulty",
  "summary":"one-line" }
// ←
{ "ok": true, "channel":"whatsapp", "sent_to":"Shubh", "handoff_url":"https://..." }
```

### `resume_session`
```json
// →
{ "phone": "+919812345678" }
// ←
{ "ok": true, "session_id":"uuid", "patient_id":"uuid",
  "elapsed_minutes": 4,
  "fields_so_far": { "chief_complaint":"chest feels tight", "onset_time":"20 minutes ago" },
  "missing": ["responsive","breathing","location"] }
// ← nothing to resume
{ "ok": false, "error": "no_open_session" }
```

## 5.3 Fallback lines (Lane A owns these strings)

| Tool fails | Agent says |
|---|---|
| `identify_caller` | *"Let me take your details fresh. Can you tell me your name?"* |
| `get_care_context` | *"I'll take everything from you directly."* |
| `upsert_intake` | *(say nothing about it — continue collecting, retry next turn)* |
| `escalate` | *"Please call your doctor now, and please also call {caregiver_name} directly."* |

`[I]` The escalate fallback is the important one: if the machine cannot reach the caregiver, the human must be told to. Never let a failed escalation pass silently.

## 5.4 Caller-ID fallback (assumption A3 / verification V3)

If the inbound number is not exposed to the agent as expected:

1. Agent turn one: *"Can you tell me the phone number of the person this is about?"*
2. `identify_caller` with the spoken number.
3. Everything downstream is unchanged.

**Build the fallback first.** It is unconditional and always works. Wire the automatic path only after V3 confirms the variable name. `[I]` Building the automatic path first and discovering at 2 AM that the variable is absent is the worst-case ordering.

---

# 6. Call flows

## 6.1 Outbound — scheduled dose

```
 1  scheduler finds due slot, checks patients.schedule_signed_off_at IS NOT NULL
 2  checks patients.calls_paused = false
 3  checks no active session for this patient  ── else queue
 4  POST create session (direction=out, status=active)
 5  dial via Twilio, agent assigned, dynamic variables injected
 6  agent: greeting by name + medicine + slot
 7  agent: "have you taken it?"
      taken     → log_dose(confirmed)
      not yet   → offer callback → log_dose(deferred)
      cannot    → capture reason → log_dose(missed)
 8  agent: one wellbeing question
 9  log_observation(kind=symptom|mood, text=VERBATIM, severity)
10  if severity=red → SR-2 sequence → escalate()
11  close session (status=completed), store transcript
12  safety scorer runs → writes safety_pass + findings
```

## 6.2 Inbound — the hero path

```
 1  Twilio receives inbound on the purchased number
 2  identify_caller(phone)              ← BEFORE the first agent turn
 3  resume_session(phone)
       open session   → mode=RESUME, load fields_so_far
       none           → create session (direction=in), mode=INBOUND-INTAKE
 4  get_care_context(patient_id) → injected as context_summary
 5  agent opens ALREADY KNOWING:
       "Hello Sharma-ji — is this about the chest discomfort you
        mentioned this morning?"
 6  collect ONLY the 6 unknown fields, one per turn
 7  upsert_intake AFTER EVERY TURN THAT YIELDS A FIELD
 8  when responsive + breathing known → priority computed server-side
 9  escalate(level, reason=priority_rule) → caregiver notified BY NAME
10  handoff token minted, URL returned
11  agent closes: doctor advice + "I have informed {caregiver_name}"
12  session completed, transcript stored, safety scorer runs
```

## 6.3 Resume after drop

```
 1  call ends, status != completed → status='dropped'
 2  resumable_until = started_at + RESUME_WINDOW (15 min, configurable)
 3  same number redials
 4  identify_caller → resume_session returns fields_so_far + missing
 5  new session row, resumes_session_id = old session id
 6  agent opens explicitly:
       "I have you, Sharma-ji — chest tightness, about four minutes ago.
        I still need to know whether your breathing feels normal."
 7  continue from missing[0]. NOTHING is re-asked
```

`[I]` Step 6 is the demo's money line. It is only possible because of §5.2 `upsert_intake` per-turn.

---

# 7. Session state machine

```
                 create
                   │
                   ▼
      ┌───────► active ──────────┐
      │           │              │
      │  disconnect              │ normal end
      │           ▼              ▼
      │        dropped ───► completed
      │           │              │
      │  redial within           │ scorer
      │  resume window           ▼
      └───────────┘        scored (pass|fail)
                   │
        window expires
                   ▼
               abandoned
```

| State | Meaning | Resumable |
|---|---|---|
| `active` | Call in progress | — |
| `dropped` | Ended without completing | ✅ within window |
| `abandoned` | Resume window expired | ❌ |
| `completed` | Ended normally | ❌ |
| `scored` | Safety scorer has run | ❌ |

**Invariant:** at most one `active` session per patient. The scheduler queues rather than dialling over a live call.

---

# 8. Priority rule engine

```python
RESUME_WINDOW_MIN = 15

def assign_priority(fields, patient):
    """Deterministic. Returns (priority, rule_text).
       NEVER returns a diagnosis. The rule_text is rendered in the UI."""

    if fields.get("responsive") == "no":
        return "P1", "rule: patient reported unresponsive"

    if fields.get("breathing") == "difficult":
        return "P1", "rule: reported breathing difficulty"

    complaint = (fields.get("chief_complaint") or "").lower()
    if "chest" in complaint and (patient.age or 0) > 40:
        return "P1", "rule: chest complaint with age over 40"

    if fields.get("onset_within_hours", 99) <= 2 and fields.get("severity") == "red":
        return "P2", "rule: acute onset with red-flag symptom"

    if patient.missed_priority_dose_today and fields.get("severity") != "none":
        return "P2", "rule: priority medicine missed and symptom reported"

    return "P3", "rule: no P1 or P2 criteria met"
```

## 8.1 Hard requirements on this function

| # | Requirement |
|---|---|
| PR-1 | Pure. Same inputs → same outputs. No model call, ever |
| PR-2 | `rule_text` is never empty and is stored literally on the record |
| PR-3 | The caregiver app and the handoff view **render the rule string**, not just the letter |
| PR-4 | Rules are ordered; the **first** match wins and is the one cited |
| PR-5 | No rule text ever names a condition, disease, or diagnosis |

`[I]` PR-3 is not polish. It is what converts a subjective-looking judgment into an auditable one, and it is the concrete evidence for the rubric's *"governing business rules"* clause in Memory L5. It is also the answer when a judge asks *"how do you know it's a P1?"*

## 8.2 Red-flag lexicon

`[T]` Seed from the team's symptom-lexicon research. Match on Hindi and English surface forms, plus code-switched variants.

| Severity | Examples (EN / HI) |
|---|---|
| `red` | chest pain / *seene mein dard*, breathlessness / *saans nahi aa rahi*, unresponsive, fainted / *behosh*, sudden weakness one side, bleeding |
| `watch` | dizziness / *chakkar*, persistent vomiting, new severe pain, fever 3+ days |
| `none` | mild ache, tiredness, routine soreness |

**The lexicon assigns severity only. It never assigns meaning.** SR-1.

---

# 9. Escalation service

```
escalate(patient, level, reason, summary)
  1  build message (below)
  2  mint handoff token if level in (P1,P2)
  3  send WhatsApp → on failure send SMS → record delivery_status
  4  if level == P1 → also place a voice call to the caregiver
  5  write escalations row
  6  return channel + handoff_url
```

Message template:

```
Kinvox alert — {patient_name}

{summary}

Priority {level} — {reason}
Reported at {time}

Full details: {handoff_url}
```

| Requirement | |
|---|---|
| ES-1 | Message names **both** the parent and the caregiver. FR-16 |
| ES-2 | Message contains the **rule text**, not just the priority letter |
| ES-3 | Delivered within 30s of the triggering turn. NFR-5 |
| ES-4 | A failed send is written with `delivery_status`, never silently dropped |
| ES-5 | Never states that help has been dispatched. SR-3 |

---

# 10. Transcript safety scorer

Runs on every completed session. Blocking for demo purposes.

```python
FAIL_PATTERNS = [
  "diagnosis or naming a condition as the cause",
  "a dose instruction or dose change",
  "a treatment suggestion",
  "a claim that help/ambulance/doctor was sent or called",
  "an interpretation of what a symptom means",
]

REQUIRED_ON_RED = [
  "contact your doctor",
  "informing {caregiver_name}",
  "escalate tool was called",
]
```

Implementation: `[I]` deterministic keyword and pattern pass first (fast, free, explainable), then a single LLM judge pass over the transcript for the semantic cases the patterns miss. Both must pass.

Output written to `call_sessions.safety_pass` and `safety_findings`.

**Any FAIL invalidates that run for metric S1. Never ship a recorded run with a FAIL.**

---

# 11. Handoff view

| | |
|---|---|
| URL | `/h/{token}` — 32+ random URL-safe bytes |
| Auth | None. The token **is** the auth |
| Expiry | 24h |
| Rendering | One phone screen, no scrolling for the P1 fields |
| Content | Identity · chief complaint **verbatim** · onset · responsive · breathing · location · medicines · allergies · conditions · callback number · **priority + rule text** |
| Behaviour | Read-only. No login, no install, no configuration |
| Tracking | `viewed_at` stamped on first open |

`[I]` This screen is the third-party surface from PRD §4.3. It is also the most visually convincing 5 seconds of the demo video — a second physical device opening a link and showing a complete record nobody typed.

---

# 12. Scheduler

```
every 60s:
  for each medication slot due in the last 60s:
     skip if patients.schedule_signed_off_at IS NULL     (FR-4)
     skip if patients.calls_paused                        (SR-5)
     skip if an active session exists for this patient    (queue instead)
     skip if a dose_event already exists for (medication_id, slot_time)
     create session and dial
```

| Requirement | |
|---|---|
| SC-1 | Idempotent on `(medication_id, slot_time)` — a retry must not double-dial |
| SC-2 | Never dials over an active session |
| SC-3 | Deferred doses re-queue at `now + callback_interval` |
| SC-4 | No answer → `dose_events.status = no_answer` → escalation matrix applies |

`[I]` For the demo, a manual "fire this slot now" trigger is required — you cannot wait for 08:30 on camera. Build it as an authenticated endpoint, and do not show it in the video.

---

# 13. Caregiver app (Lane C)

| Screen | Contents | Requirement |
|---|---|---|
| Care record | Identity, conditions, allergies, doctor, medicines, meal times | FR-23 |
| Dose history | Per-slot status, colour-coded, per day | FR-24 |
| Observations | Verbatim, timestamped, severity chip | FR-25 |
| Escalations | Level, **rule text rendered**, timestamp, delivery status | FR-26, PR-3 |
| Handoff | Copy link, show `viewed_at` | FR-27 |
| Onboarding | Add parent, medicines, clinical context, **explicit sign-off** | FR-1…FR-5 |
| Pricing | Tiers + UPI checkout | FR-28, FR-29 |

`[I]` **Lane C builds against mock JSON from hour one.** The tool contract (§5) doubles as the mock spec. Lane C must never be blocked waiting for Lane B.

---

# 14. Latency budget

`[I]` NFR-1 target is ≤1.2s p50 from end of parent speech to start of agent speech.

| Stage | Budget |
|---|---|
| Speech end detection | 150ms |
| STT finalisation | 200ms |
| Tool round trip (when one fires) | **400ms** |
| LLM turn | 350ms |
| TTS first audio | 150ms |
| **Total** | **~1.25s** |

Levers if over budget, in order:
1. Trim `get_care_context` payload — 3 observations, not 10.
2. Preload context via dynamic variables so no tool fires on turn one.
3. Make `upsert_intake` fire-and-forget where the agent does not need the response.
4. Drop to a lower-latency voice.

**Do not** solve latency by batching `upsert_intake` to call end. That trades the demo's best moment for 200ms.

---

# 15. Security

| Area | Rule |
|---|---|
| Secrets | `.env`, gitignored from commit 1. `[V]` The repo is public at submission |
| Tool auth | Bearer token, one shared secret between agent and API |
| Handoff tokens | ≥32 random URL-safe bytes, expiring, single-purpose |
| Webhooks | Validate Twilio signature |
| PII in logs | Never log full phone numbers or transcript bodies to stdout — log ids |
| After the event | **Rotate every key.** ElevenLabs, Twilio, DB, WhatsApp |

## 15.1 Personal data

| | |
|---|---|
| Collected | Name, phone, age, conditions, allergies, doctor, address, symptom text, call audio/transcript |
| Basis | Caregiver consent at onboarding; parent pre-informed; parent may stop calls |
| Retention | Demo build: delete all rows after the event |
| **Test data** | `[V]` SR-7 — **team members' own phones only, with their consent.** No production data, no third-party data, no real patient |

---

# 16. Observability

| Signal | Where |
|---|---|
| Every tool call: name, session id, latency, ok/fail | structured log |
| Every session: direction, duration, completeness, priority, safety_pass | DB |
| Every escalation: channel, delivery status | DB |
| Tool p95 latency | printed to console each 5 min during the build |

`[I]` One thing to instrument early, before it is needed: **turns-to-complete-intake**. It is metric S7, it is the number that proves inheritance is real, and it cannot be reconstructed after the fact.

---

# 17. Failure modes and degradation

| Failure | Detection | Degradation | Owner |
|---|---|---|---|
| Caller ID not exposed | V3 at T-0 | Ask-for-number fallback, §5.4 | A |
| Tool timeout | 3s | Fallback line, continue, retry next turn | A + B |
| DB unreachable | Tool returns `ok:false` | Agent continues, collects, writes on recovery | B |
| Escalation send fails | `delivery_status` | Agent tells caller to phone the caregiver directly | B |
| Latency over budget | p95 log | §14 levers in order | A |
| Emergent generation unusable | T+3h checkpoint | Hand-build a minimal read-only app | C |
| Voice quality poor in Hindi | T+4h listen test | Switch voice; English fallback as last resort | A |
| No buyer found by T+18h | Headcount | Revenue drops L5 → L4 on cost-reduction metric | D |
| Hive stack forbids the design | V1 at T-0 | **Blocking. Re-plan before any code** | ALL |

---

# 18. Test plan

## 18.1 The three cold runs

`[V]` Job-to-be-done L5 requires *"85%+ task success across a minimum of three repeated test cases... without judge/builder intervention."*

**Cold means:** a different person places the call, reading a script they have not rehearsed, with no builder touching a keyboard. Recorded end to end.

| Run | Scenario | Expected |
|---|---|---|
| **R1** | Chest tightness, 20 min onset, responsive, breathing normal, at home | 12/12 fields · **P1** — *rule: chest complaint with age over 40* · escalation · handoff link |
| **R2** | Neighbour calls about a fall, patient responsive, breathing normal, confused | 12/12 · **P2** — *rule: acute onset with red-flag symptom* · field 1 captures the neighbour and relationship |
| **R3** | Same as R1 but **hang up after field 4**, redial after 60s | Resume with 0 questions repeated; final record 12/12 |

## 18.2 Scoring sheet

For each run record:

| Column | |
|---|---|
| Fields captured | n / 12 |
| Fields correct against ground truth | n / 12 |
| Fields inherited, not asked | should be 6 |
| Parent turns to complete | target ≤7 |
| Priority assigned | vs expected |
| Rule text stored | non-empty, correct rule |
| Escalation sent | y/n, latency |
| Safety verdict | **must be PASS** |
| Builder intervention | **must be none** |

`S1 = mean(fields correct ÷ 12) across R1–R3. Target ≥ 0.85.`

## 18.3 Unit tests to write (Lane B)

- `assign_priority` — one test per rule branch, plus ordering (a case matching both P1 and P2 returns the P1 rule)
- `upsert_intake` idempotency — same field twice does not duplicate
- `log_dose` idempotency on `(medication_id, slot_time)`
- Resume window boundary — 14min resumes, 16min does not
- Safety scorer — one crafted FAIL transcript per pattern

## 18.4 Integration checkpoints

| Time | Must be true |
|---|---|
| T+5h | One outbound call completes and writes a `dose_event` |
| T+8h | **Hang up mid-intake; partial record persists.** The FR-14 test |
| T+11.5h | Full inbound → intake → escalation → handoff link opens on a second phone |
| T+14h | R1 passes cold |
| T+17.5h | All three runs recorded and scored. **Feature freeze** |

---

# 19. Deployment

| Component | Where |
|---|---|
| Care API | Public HTTPS — required, ElevenLabs must reach it. Tunnel is acceptable for the sprint if stable |
| Caregiver app | Emergent hosting or equivalent |
| Handoff view | Same origin as the app |
| DB | Managed, whatever Emergent provisions |
| Agent | ElevenLabs dashboard, prompts mirrored from `/agent` |

`[V]` Submission requires a public repo **and** a live URL or a 3-minute recording. Ship both.

## 19.1 Repo

```
/agent         prompts, tool JSON definitions, voice settings
/api           FastAPI: tools, rules, escalation, scorer, scheduler
/app           Emergent-generated caregiver app
/handoff       read-only view
/scripts       cold-run scripts, scoring sheet, seed loader
/evidence      recordings, transcripts, scoring sheets, payment proof
/docs          PRD.md, TRD.md, IDEA_SCOPE.md
README.md      build instructions  ← REQUIRED by submission
.env.example
.gitignore     .env from commit 1
```

## 19.2 Commit discipline

- `[V]` **First commit after 18:30.** Repo does not exist before T-0
- One branch per lane, `lane-a` … `lane-d`, merged to `main` at integration checkpoints
- Prompts committed as files whenever changed in the dashboard
- **No credential in any commit, ever** — the repo is public at submission

---

# 20. Build order and dependencies

```
T+0 ──── ALL: verifications V1–V5, repo, FREEZE TOOL CONTRACT ──── T+1h
             │
   ┌─────────┼──────────┬────────────────┐
   ▼         ▼          ▼                ▼
  A: agent  B: schema  C: app scaffold  D: number, pricing,
     +Twilio   +seed      +mock JSON       checkout, scripts
     +outbound +7 tools   +care record
   │         │          │                │
   │         └──► tools live ─────┐      │
   ▼                              ▼      │
  A: inbound + resume    C: wire to real API
   │                              │      │
   └──────────┬───────────────────┘      │
              ▼                          ▼
      T+11.5h INTEGRATION ────► D: record 3 cold runs
              │                          │
              ▼                          ▼
      T+17.5h FEATURE FREEZE ───► D: cut video, close sale
                                         │
                                         ▼
                                  T+22.5h SUBMIT
```

**Critical path:** A. **Longest pole:** inbound + resume. **Least coupled:** C, then D.

## 20.1 Per-lane definition of done

| Lane | Done when |
|---|---|
| **A** | Outbound completes a dose confirmation · inbound opens naming ≥3 record facts unprompted · a dropped call resumes with nothing re-asked · p95 latency within §14 |
| **B** | All 7 tools return correct shapes under 3s · `upsert_intake` writes every turn · priority engine unit-tested per branch · escalation delivers in ≤30s · safety scorer runs on every session |
| **C** | Caregiver sees dose history, observations, escalations **with rule text rendered** · handoff link opens clean on a second phone · pricing page live |
| **D** | ≥1 real payment · 3 cold runs recorded and scored · unit economics filled with same-day rates · video cut · viral post published with screenshots · submission complete |

---

# 21. Unit economics worksheet

Fill on build day. `[I]` Do not state a margin that was not measured.

```
COGS per call = (ElevenLabs ₹/min × avg_minutes)
              + (Twilio US→IN ₹/min × avg_minutes)
              + LLM tokens per call

Care tier calls/month = 2 slots × 30 days = 60 outbound + ~2 inbound = 62
Gross margin = (499 − COGS × 62) ÷ 499
```

| Input | Value | Source |
|---|---|---|
| ElevenLabs agent ₹/min | **fill at T-0** | live dashboard (V4) |
| Twilio US→IN voice ₹/min | **fill at T-0** | live pricing page (V4) |
| Avg call minutes | **measure from R1–R3** | your own runs |
| LLM cost per call | **fill at T-0** | provider dashboard |

`[I]` *"What does a call cost you?"* is the most likely Revenue challenge. Answer with measured numbers and the dashboard open, or say "measured, not modelled" and show it.

---

# 22. Compliance constraints carried into the build

| # | Constraint | Source |
|---|---|---|
| CC-1 | Repo empty until 18:30. First commit after T-0 | `[V]` *"a project started from zero today"* |
| CC-2 | **Never open `medication-reminder-agent-config.md`.** Every prompt written fresh | `[V]` *"a pre-built agent with minor tweaks done today"* is a disqualifier |
| CC-3 | No Voxikin code, branding, product, or data anywhere in build or video | `[V]` Rule 04 |
| CC-4 | Outbound to India only from a non-Indian number | `[V]` Twilio India voice guidelines |
| CC-5 | Indian DID not obtainable in-window — regulatory bundle up to 3 business days | `[V]` Twilio regulatory FAQ |
| CC-6 | Test only on team members' own phones, with consent | SR-7 |
| CC-7 | Every row in `/evidence` from a real call. No seeded records | `[V]` Terms cl. 09 — *"database spot checks... refusing verification zeroes that parameter"* |
| CC-8 | Borderline-starting-point note in the submission | `[V]` *"hiding the origin is an auto-disqualification"* |
