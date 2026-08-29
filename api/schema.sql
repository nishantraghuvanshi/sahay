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
  caregiver_id  TEXT NOT NULL REFERENCES caregivers(id),
  name          TEXT NOT NULL,
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

  -- design doc §10: the scheduler accepts only confirmed schedules, and these are
  -- REQUIRED rather than nullable-with-a-default. A nullable confirmed_by is a
  -- gate that defaults to open.
  confirmed_by  TEXT NOT NULL REFERENCES caregivers(id),
  confirmed_at  TEXT NOT NULL,

  -- When the caregiver stopped this medicine. Soft rather than a DELETE: dose_events
  -- reference this row, and a stopped medicine's history is still the record of what
  -- was taken. Rows with stopped_at set are excluded from the schedule everywhere.
  stopped_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_meds_patient ON medications(patient_id);

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
  call_session_id TEXT REFERENCES call_sessions(id),
  -- 'unknown' is the degraded case (the agent could not reach the patient) and is
  -- deliberately distinct from 'missed', which asserts the dose was not taken.
  status          TEXT NOT NULL,          -- 'confirmed'|'deferred'|'missed'|'no_answer'|'unknown'
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
