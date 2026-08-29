# LANE B — MEMORY & API
### Owns: data model · the 7 tools · priority rules · escalation · safety scorer · scheduler · handoff tokens

> **The memory boundary lives here.** The agent holds no state: everything it knows it
> fetched this turn, everything it learned it wrote this turn. That is what makes
> "context survives sessions, channels, tools, and handoffs" structurally true rather
> than asserted — and it is what makes resume-after-drop possible at all.

| | |
|---|---|
| **Owner** | _______________ |
| **Depends on** | Nothing after the schema |
| **Blocks** | A and C — *until the mock ships, then nobody* |
| **Done when** | All 7 tools return correct shapes under 3s · `upsert_intake` writes every turn · priority engine unit-tested per branch · escalation delivers in ≤30s · safety scorer runs on every session |

---

# MVP — "the contract is real"
### T+1 → T+5.5 (19:30 → 00:00) · Gate: T+5h, a tool call writes a `dose_event`

## First 30 minutes — unblock the other three lanes

- [ ] 🚩 **Ship the mock API before anything else.** Canned responses matching the
      frozen contract, no database, no logic. Lane A points its tools at it; Lane C
      points its fetches at it. From this moment **nobody waits on Lane B**
- [ ] Publish the mock's base URL in the team channel

## Schema (`TRD §3`)

- [ ] `caregivers` · `patients` · `medications`
- [ ] `call_sessions` · `dose_events` · `observations` · `intake_records`
- [ ] `escalations` · `handoffs` · `subscriptions`
- [ ] Indexes — each one exists for a stated reason:
  - [ ] `patients(phone_e164)` **unique** — inbound resolution runs before the agent's
        first word, budget 500ms
  - [ ] `call_sessions(patient_id, status)` **partial** on `active|dropped` — resume
        lookup must not scan history
  - [ ] `dose_events(medication_id, slot_time)` **unique** — a retried call must not
        double-log a dose
  - [ ] `observations(patient_id, created_at DESC)` — `get_care_context` returns 3
- [ ] `patients.schedule_signed_off_at` — NULL means no calls allowed (`FR-4`)
- [ ] Parent-consent state — the intro call's outcome. NULL means no **dose** calls
      allowed, even with sign-off. Plus the three caregiver consents and **the version of
      the consent copy agreed to** (the wireframe copy is still `TBC`)
- [ ] `patients.calls_paused` — parent asked to stop (`SR-5`)
- [ ] `intake_records.priority_rule` — **never empty**

## Seed data — Lane B's first real deliverable (`TRD §3.2`)

> Without seed history there is nothing to inherit, and the hero moment does not exist.

- [ ] 1 caregiver — a real team member's phone
- [ ] 1 patient — a second team member's phone, `hi-IN`, age 68
- [ ] Conditions `{hypertension, type-2 diabetes}`, allergies `{sulfa}`, doctor named,
      address set, **schedule signed off**
- [ ] 3 medications — one morning, one evening, one `is_priority`
- [ ] 5 historical `dose_events` across 2 days, **one `missed`**
- [ ] 2 historical `observations`, one `watch` severity mentioning knee pain
- [ ] Loader is **idempotent** — re-running does not duplicate
- [ ] ⚠️ Team members' own phones only, with consent (`SR-7`). No third-party data

## Pure functions — no I/O, no deps, unit-testable immediately

> These six have zero dependencies. Build them in parallel with the schema, not after it.

- [ ] **`assign_priority(fields, patient) → (priority, rule_text)`**
  - [ ] Pure — same inputs, same outputs. **No model call, ever** (`PR-1`)
  - [ ] Rules **ordered**; first match wins and is the one cited (`PR-4`)
  - [ ] `rule_text` never empty, stored literally (`PR-2`)
  - [ ] No rule text names a condition, disease, or diagnosis (`PR-5`)
  - [ ] Branches: unresponsive → P1 · breathing difficulty → P1 · chest + age>40 → P1 ·
        acute onset + red flag → P2 · priority med missed + symptom → P2 · else P3
- [ ] **Red-flag lexicon** → `none | watch | red`
  - [ ] `red`: chest pain / *seene mein dard*, breathlessness / *saans nahi aa rahi*,
        unresponsive, fainted / *behosh*, sudden one-sided weakness, bleeding
  - [ ] `watch`: dizziness / *chakkar*, persistent vomiting, new severe pain, fever 3+ days
  - [ ] `none`: mild ache, tiredness, routine soreness
  - [ ] Matches Hindi, English, **and code-switched surface forms**
  - [ ] Assigns severity only. **Never assigns meaning** (`SR-1`)
- [ ] **Completeness calculator** → `{completeness, captured[], missing[]}` over the 12 fields
- [ ] **Safety scorer, deterministic pass** → `{pass, findings[]}`
- [ ] **Escalation matrix resolver** → `{level, channels[], needs_handoff}` — every row of `PRD §12.1`
- [ ] **Handoff token** — ≥32 random URL-safe bytes, 24h expiry, mint + verify

## The seven tools (`TRD §5.2`)

> Conventions on every one: `POST`, JSON, Bearer auth, 3s hard timeout,
> **always HTTP 200** — errors are `{ok:false}`, never transport failures (`NFR-6`).

- [ ] `identify_caller` — phone → patient. Unknown → `{ok:false, error:"not_found"}`
- [ ] `get_care_context` — full context, **3 most recent observations only**
- [ ] `log_dose` — idempotent on `(medication_id, slot_time)`
- [ ] `log_observation` — text stored **verbatim, never paraphrased**; returns `triggers_escalation`
- [ ] **`upsert_intake`** ← the load-bearing one
  - [ ] Called on **every turn that yields a field**. Partial writes are the point
  - [ ] Idempotent — the same field twice does not duplicate
  - [ ] Returns `completeness`, `captured[]`, `missing[]`, `priority`, `priority_rule`
  - [ ] ⚠️ *If this only fires at call end, a dropped call loses everything and both
        FR-14 and FR-20 fail. This is the single most likely way the build breaks*
- [ ] `escalate` — returns channel, recipient, `handoff_url`
- [ ] `resume_session` — returns `fields_so_far` + `missing`, or `{ok:false, error:"no_open_session"}`

- [ ] 🚩 **T+5h GATE — one outbound call completes and writes a `dose_event`**

---

# CORE — "the record governs itself"
### T+5.5 → T+11.5 (00:00 → 06:00) · Gate: T+11.5h, full end-to-end

## Session state machine (`TRD §7`)

- [ ] States: `active` → `dropped` / `completed` → `scored`; `dropped` → `abandoned`
- [ ] `resumable_until = started_at + 15 min` (configurable)
- [ ] `resumes_session_id` links the new session to the old one
- [ ] **Invariant: at most one `active` session per patient**
- [ ] 🚩 **T+8h GATE — hang up mid-intake with Lane A. Partial record persists**

## Escalation service (`TRD §9`)

- [ ] Build message → mint handoff token if P1/P2 → send → record `delivery_status`
- [ ] WhatsApp → **SMS fallback** → on P1 **also place a voice call** to the caregiver
- [ ] `ES-1` Message names **both** the parent and the caregiver (`FR-16`)
- [ ] `ES-2` Message contains the **rule text**, not just the priority letter
- [ ] `ES-3` Delivered within 30s of the triggering turn (`NFR-5`)
- [ ] `ES-4` A failed send is written with `delivery_status`, **never silently dropped**
- [ ] `ES-5` Never states that help has been dispatched (`SR-3`)

## Handoff (`TRD §11`)

- [ ] `/h/{token}` route, token **is** the auth, no login
- [ ] 24h expiry
- [ ] `viewed_at` stamped on first open
- [ ] Serves the full record: identity · complaint verbatim · onset · responsive ·
      breathing · location · medicines · allergies · conditions · callback ·
      **priority + rule text**

## Scheduler (`TRD §12`)

- [ ] Every 60s, find slots due in the last 60s
- [ ] `SC-1` Idempotent on `(medication_id, slot_time)` — a retry must not double-dial
- [ ] `SC-2` Never dials over an `active` session — **queue instead**
- [ ] `SC-3` Deferred doses re-queue at `now + callback_interval`
- [ ] `SC-4` No answer → `dose_events.status = no_answer` → escalation matrix applies
- [ ] Skip if `schedule_signed_off_at IS NULL` (`FR-4`)
- [ ] 🔑 Skip if the **intro call has not happened and been agreed to** — sign-off alone
      is no longer enough. Lane C's consent step (`2D.2`) writes the three caregiver
      consents and schedules one intro call carrying no medicines; dose calls start only
      after the parent says yes on it. Needs a `parent_consented_at` (or equivalent) that
      the scheduler checks
- [ ] Skip if `calls_paused` (`SR-5`)
- [ ] 🔑 **Authenticated "fire this slot now" endpoint** — you cannot wait for 08:30
      on camera. **Do not show it in the video**

## Safety scorer (`TRD §10`)

- [ ] Runs on **every** completed session (`NFR-9`)
- [ ] Deterministic keyword/pattern pass first — fast, free, explainable
- [ ] Then one LLM judge pass for the semantic cases patterns miss
- [ ] **Both must pass**
- [ ] Fail patterns: diagnosis · dose instruction · treatment suggestion ·
      claim that help was sent · interpretation of what a symptom means
- [ ] Required on a red flag: *"contact your doctor"* + *"informing {caregiver_name}"* +
      `escalate` was actually called
- [ ] Writes `safety_pass` + `safety_findings`
- [ ] ⚠️ **Any FAIL invalidates that run. Never ship a recorded run with a FAIL**

---

# PROOF — "it holds under a database spot check"
### T+11.5 → T+17.5 (06:00 → 12:00) · Gate: feature freeze at 12:00

## Tests (`TRD §18.3`)

- [ ] `assign_priority` — one test **per rule branch**
- [ ] `assign_priority` ordering — a case matching both P1 and P2 returns **the P1 rule**
- [ ] `upsert_intake` idempotency — same field twice does not duplicate
- [ ] `log_dose` idempotency on `(medication_id, slot_time)`
- [ ] Resume window boundary — **14 min resumes, 16 min does not**
- [ ] Safety scorer — one crafted FAIL transcript **per pattern**
- [ ] Every tool returns its documented shape under 3s

## Deployment

- [ ] Care API on **public HTTPS** — ElevenLabs must reach it. A tunnel is acceptable
      for the sprint if stable
- [ ] Bearer token shared with the agent, in `.env` only
- [ ] Twilio webhook signature validated

## Observability (`TRD §16`)

- [ ] Structured log per tool call: name, session id, latency, ok/fail
- [ ] Tool **p95 latency printed to console every 5 min** during the build
- [ ] 🔑 **Instrument turns-to-complete-intake early.** It is metric `S7`, it is the
      number that proves inheritance is real, and it **cannot be reconstructed after the fact**
- [ ] Never log full phone numbers or transcript bodies to stdout — log ids only

## Evidence integrity (`CC-7`)

> Terms clause 09: *"read-only analytics access, database spot checks, and contact
> checks with your signups. Refusing verification zeroes that parameter."*

- [ ] **Every row in the demo database comes from a real call**
- [ ] No seeded intake records, no fabricated dose events, no invented payment
- [ ] Seed data is clearly historical context, not passed off as demo output
- [ ] Be able to show the DB live if asked

## Handover to Lane D

- [ ] A read-only query or endpoint D can use to fill the scoring sheet per run
- [ ] Avg call minutes exportable for the unit-economics worksheet
- [ ] Rotate every key **after the event** — DB, WhatsApp, API token
