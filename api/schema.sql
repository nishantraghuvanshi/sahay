-- Care API schema. Source of truth: TRD §3, translated to SQLite.
--
-- SQLite rather than Postgres because this has to run from a clone with no
-- service to provision. The column names, nullability and indexes are TRD §3
-- unchanged, so the move to Postgres is a type substitution and not a redesign:
--
--   UUID          -> TEXT   (uuid4 strings)
--   TEXT[]        -> TEXT   (JSON array)
--   JSONB         -> TEXT   (JSON object)
--   TIMESTAMPTZ   -> TEXT   (ISO-8601, always UTC, always with an offset)
--   BOOLEAN       -> INTEGER (0/1)
--
-- Columns marked [GAP-n] are additions raised in docs/SCHEMA-GAPS-LANE-C.md.
-- They are here because the app already collects the values and had nowhere to
-- put them.

PRAGMA foreign_keys = ON;

-- ============ people ============

CREATE TABLE IF NOT EXISTS caregivers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  phone_e164        TEXT NOT NULL UNIQUE,
  email             TEXT,
  relationship      TEXT,
  phone_verified_at TEXT,                 -- [GAP-1] signup verifies by OTP
  email_verified_at TEXT,                 -- [GAP-1]
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id            TEXT PRIMARY KEY,
  -- Nullable: the agent resolves inbound callers, and a patient it has met but
  -- whose caregiver nobody has recorded is a real state, not a broken row. It was
  -- NOT NULL while onboarding was the only thing that created patients.
  caregiver_id  TEXT REFERENCES caregivers(id),
  -- Nullable: an inbound caller the agent has resolved by number but who has told
  -- it no name is a real record, not a broken one.
  name          TEXT,
  honorific     TEXT,
  phone_e164    TEXT NOT NULL UNIQUE,     -- HOT PATH: inbound resolution
  language      TEXT NOT NULL DEFAULT 'hi-IN',
  age           INTEGER,
  conditions    TEXT NOT NULL DEFAULT '[]',
  allergies     TEXT NOT NULL DEFAULT '[]',
  doctor_name   TEXT,
  doctor_phone  TEXT,
  address_text  TEXT,
  meal_times    TEXT,                     -- {"breakfast":"08:00",...}

  -- From the scheduler's model. `timezone` is what makes a local 'HH:MM' slot a real
  -- instant, and getting it wrong moves every dose by hours; `quiet_windows` is the
  -- caregiver's do-not-call hours, which the dialler honours except for a priority
  -- medicine. Both are load-bearing for placing a call at the right moment.
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  quiet_windows TEXT,                     -- [{"from":"22:00","to":"07:00"}]

  -- The single medicine the agent was originally built around, before
  -- `medications` existed. Still read on the call path to fill a prompt variable.
  -- Superseded by `medications`; kept because 28 call sites still name it.
  drug_name     TEXT,
  notes         TEXT,
  updated_at    TEXT,

  -- FR-4 gate. NULL = no call may ever be placed.
  schedule_signed_off_at TEXT,
  calls_paused  INTEGER NOT NULL DEFAULT 0,

  -- [GAP-2] The consent gate (1E.2). `intro_call_status` is load-bearing: the
  -- scheduler must not dial a dose slot until it is 'done', or the product calls
  -- a parent who never agreed to be called.
  intro_call_at     TEXT,
  intro_call_status TEXT,                 -- 'pending'|'done'|'declined'
  consents          TEXT,                 -- [{id, text, agreed_at}] — stored WITH
                                          -- their text; a consent you cannot
                                          -- reproduce is not evidence

  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone_e164);

-- ============ clinical config ============

CREATE TABLE IF NOT EXISTS medications (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id),
  name          TEXT NOT NULL,
  dose          TEXT NOT NULL,
  slots         TEXT NOT NULL DEFAULT '[]',   -- ['08:30','21:00'] local
  with_food     TEXT,
  is_priority   INTEGER NOT NULL DEFAULT 0,   -- at most one per patient
  stock_count   INTEGER,

  -- [GAP-4] duration read off the prescription, and the date reminders stop.
  duration_days INTEGER,
  end_date      TEXT,

  -- When the course begins. From the scheduler's model (agent/): without it a
  -- taper — the same medicine at a different dose from a later date — cannot be
  -- expressed, and the dialler has no way to know a course has not started yet.
  --
  -- NOT NULL deliberately. It is half of the (patient_id, name, start_date) key
  -- that lets a taper exist as two rows, and SQLite treats NULLs as distinct in a
  -- unique index — so a nullable start_date would silently admit duplicates of the
  -- regimen the index exists to deduplicate.
  start_date    TEXT NOT NULL DEFAULT (date('now')),

  -- [GAP-7] Provenance. Safety rule S3 requires the verbatim line the model read
  -- to survive to a reviewer; without these the evidence for every row is
  -- discarded the moment the schedule is confirmed.
  source           TEXT NOT NULL DEFAULT 'manual',  -- 'prescription'|'manual'
  source_doc_id    TEXT,
  raw_line         TEXT,
  confidence       REAL,
  extraction_flags TEXT NOT NULL DEFAULT '[]',

  -- Read from the page, deliberately never scheduled (PRN, injection, ointment,
  -- drops). Without this an SOS medicine becomes an ordinary row with no slots,
  -- and any scheduler that fills in a default time starts calling about it.
  excluded         INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,

  -- Who signed this row off, and when. Nullable, which reverses an earlier call in
  -- this file — the reasoning changed when the two schemas merged.
  --
  -- design doc §10 requires that no unconfirmed schedule reaches the scheduler. That
  -- is enforced in the two places that actually bite: POST /app/onboarding refuses a
  -- draft whose schedule was not signed off, and the dial policy's *first* check is
  -- `patient.schedule_signed_off_at == null -> skip`. Making the column NOT NULL as
  -- well only blocked rows that legitimately exist before anyone has confirmed them
  -- — a seeded regimen, or a prescription read but not yet reviewed.
  confirmed_by  TEXT REFERENCES caregivers(id),
  confirmed_at  TEXT,
  created_at    TEXT,
  updated_at    TEXT,

  -- When the caregiver stopped this medicine. Soft rather than a DELETE: dose_events
  -- reference this row, and a stopped medicine's history is still the record of what
  -- was taken. Rows with stopped_at set are excluded from the schedule everywhere.
  stopped_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_meds_patient ON medications(patient_id);

-- One regimen per medicine per start date. Re-running a seed, or the same taper
-- being written twice, updates the row instead of adding a duplicate; a later
-- start_date is a genuinely different regimen and gets its own row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meds_patient_name_start
  ON medications(patient_id, name, start_date);

-- ============ calls ============

CREATE TABLE IF NOT EXISTS call_sessions (
  id                       TEXT PRIMARY KEY,
  patient_id               TEXT REFERENCES patients(id),   -- NULL until resolved
  direction                TEXT NOT NULL,                  -- 'in'|'out'
  status                   TEXT NOT NULL,
  started_at               TEXT NOT NULL,
  ended_at                 TEXT,
  provider_conversation_id TEXT,
  provider_call_sid        TEXT,
  resumes_session_id       TEXT REFERENCES call_sessions(id),
  resumable_until          TEXT,
  transcript               TEXT,
  safety_pass              INTEGER,
  safety_findings          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_patient_open
  ON call_sessions(patient_id, status);

-- ============ what calls produce ============

CREATE TABLE IF NOT EXISTS dose_events (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  medication_id   TEXT NOT NULL REFERENCES medications(id),
  slot_time       TEXT NOT NULL,
  -- Where a single occurrence was moved to. `medications.slots` are recurring, so a
  -- one-off move has nowhere else to live; the row keeps its original slot_time as
  -- its identity and carries the new time here. Only meaningful with
  -- status='deferred', which already means "put off to a later time, still expected".
  rescheduled_to  TEXT,
  call_session_id TEXT REFERENCES call_sessions(id),
  -- The provider's own call id, which is what the dialler has to hand when it logs
  -- an outcome. Not a duplicate of call_session_id: that points at `call_sessions`
  -- (the record's view of a call), this at `calls` (the dialler's working state).
  -- Either may be set without the other.
  call_id         TEXT,
  -- 'pending' is the scheduler's own state: the row exists so retry bookkeeping has
  -- somewhere to live, and nothing has been established yet. It is NOT an outcome —
  -- the app reads it exactly as it reads no row at all.
  -- 'unknown' is the degraded case (the agent could not reach the patient) and is
  -- deliberately distinct from 'missed', which asserts the dose was not taken.
  status          TEXT NOT NULL,          -- 'pending'|'confirmed'|'deferred'|'missed'|'no_answer'|'unknown'

  -- Retry bookkeeping, from the scheduler's model (agent/). The initial dial at
  -- slot_time plus retries counts up from attempt_count; next_attempt_at is when the
  -- row becomes eligible again, so a dose already dialled once is not picked up
  -- before its retry is due. Without these two columns the dialler cannot work.
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,

  -- Who established the outcome: 'agent', 'caregiver', or 'patient'. A dose the
  -- caregiver ticked in the app and one the patient confirmed on a call are
  -- different facts, and the record should not flatten them.
  actor           TEXT,
  -- When the outcome was established, as distinct from when the row was written.
  confirmed_at    TEXT,
  updated_at      TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);
-- Idempotency: a retried call must not double-log a dose (TRD §3.1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_dose_slot ON dose_events(medication_id, slot_time);

CREATE TABLE IF NOT EXISTS observations (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  call_session_id TEXT REFERENCES call_sessions(id),
  kind            TEXT NOT NULL,          -- 'symptom'|'mood'|'note'
  text            TEXT NOT NULL,          -- VERBATIM. never paraphrased
  severity        TEXT NOT NULL,          -- 'none'|'watch'|'red'
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_patient_recent
  ON observations(patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intake_records (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT REFERENCES patients(id),
  call_session_id TEXT NOT NULL REFERENCES call_sessions(id),
  fields          TEXT NOT NULL DEFAULT '{}',
  completeness    REAL,
  priority        TEXT,
  priority_rule   TEXT,                   -- LITERAL rule text. never empty
  status          TEXT NOT NULL DEFAULT 'open',
  updated_at      TEXT NOT NULL
);

-- ============ downstream ============

CREATE TABLE IF NOT EXISTS escalations (
  id               TEXT PRIMARY KEY,
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  intake_record_id TEXT REFERENCES intake_records(id),
  -- Which dose this alert was raised about, when it was raised because a slot
  -- could not be established. Without it "the escalation that fired" cannot be
  -- named next to the dose, only guessed at from timestamps.
  dose_event_id    TEXT REFERENCES dose_events(id),
  level            TEXT NOT NULL,
  reason           TEXT NOT NULL,
  channel          TEXT NOT NULL,
  sent_to          TEXT NOT NULL,
  sent_at          TEXT,
  delivery_status  TEXT,
  payload          TEXT
);

CREATE TABLE IF NOT EXISTS handoffs (
  id               TEXT PRIMARY KEY,
  intake_record_id TEXT NOT NULL REFERENCES intake_records(id),
  token            TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT,
  viewed_at        TEXT
);

-- [GAP-5] The escalation ladder needs contacts with numbers; onboarding already
-- collects name / relationship / after-how-long and dropped them on the floor.
CREATE TABLE IF NOT EXISTS escalation_contacts (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id),
  name          TEXT NOT NULL,
  relationship  TEXT,
  phone_e164    TEXT,
  after_minutes INTEGER,                  -- NULL = critical only
  rank          INTEGER NOT NULL
);

-- [GAP-3] Medicine edits need an audit row: who changed what, when, and the
-- consent text they ticked.
CREATE TABLE IF NOT EXISTS medication_changes (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES patients(id),
  changed_at   TEXT NOT NULL,
  changed_by   TEXT REFERENCES caregivers(id),
  diff         TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  consent_ack  INTEGER NOT NULL
);


-- ============ the dialler's own working state ============
--
-- Owned by agent/. Nothing outside it reads these: they are how a call is conducted,
-- not what a call produced. What a call *produced* — a dose outcome, an observation,
-- an escalation — lands in the tables above, which is what the caregiver app renders.
--
-- Kept as their own tables rather than merged into `call_sessions` because the two
-- describe different things at different grains, and a merge would be a third
-- rewrite for no reader's benefit.

CREATE TABLE IF NOT EXISTS calls (
  id               TEXT PRIMARY KEY,
  call_id          TEXT UNIQUE NOT NULL,   -- the provider's id
  use_case         TEXT,
  language         TEXT,
  phone            TEXT,
  variables        TEXT,
  outcome_label    TEXT,
  outcome_source   TEXT,
  outcome_reason   TEXT,
  transcript       TEXT,
  duration_seconds REAL,
  cost             REAL,
  created_at       TEXT DEFAULT (datetime('now')),
  ended_at         TEXT,
  prompt_version   TEXT,
  parent_id        TEXT,
  attempt_number   INTEGER,
  recording_url    TEXT,
  ground_truth     TEXT,
  -- When the caregiver was told about this call, and how. Stamped by the alert
  -- plugin so a second failure does not send a second alert about the same call.
  alert_sent_at    TEXT,
  alert_channel    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT UNIQUE NOT NULL,
  patient_id    TEXT REFERENCES patients(id) ON DELETE CASCADE,
  call_id       TEXT,
  direction     TEXT,
  status        TEXT NOT NULL,
  fields_so_far TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  ended_at      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  call_id    TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT,
  tool_calls TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
