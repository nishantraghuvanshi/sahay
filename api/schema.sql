-- spec: TRD §3
-- Tables + indexes. Each index exists for a stated reason.
--
-- Apply with:  psql "$DATABASE_URL" -f api/schema.sql
-- Re-runnable: every statement is IF NOT EXISTS, so this doubles as the migration.
--
-- §3 is copied column-for-column from the TRD. The auth tables at the bottom are
-- additive and were never in it — see docs/SCHEMA-GAPS-LANE-C.md gap #1.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ============ people ============

CREATE TABLE IF NOT EXISTS caregivers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  phone_e164    TEXT NOT NULL UNIQUE,
  email         TEXT,
  relationship  TEXT,                     -- 'son','daughter','nephew',...
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Gap #1 (docs/SCHEMA-GAPS-LANE-C.md): screen 1a verifies both by OTP and the
-- record had nowhere to say so. NULL means "never proved", which is not the
-- same as "absent" — email may be present and unverified.
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- A caregiver row is created by the first successful phone OTP, before they
-- have typed a name. NOT NULL still has to hold, so it starts empty and screen
-- 1b fills it in.
ALTER TABLE caregivers ALTER COLUMN name SET DEFAULT '';

-- Email is an identity here (step 3/4 of signup), so it cannot collide.
-- Partial: many caregivers legitimately have no email at all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_caregivers_email
  ON caregivers(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS patients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone_e164);
-- The caregiver app asks "which patients are mine?" on every authenticated read.
CREATE INDEX IF NOT EXISTS idx_patients_caregiver ON patients(caregiver_id);

-- ============ clinical config ============

CREATE TABLE IF NOT EXISTS medications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  dose          TEXT NOT NULL,            -- '500mg', '1 tablet'
  slots         TEXT[] NOT NULL,          -- ['08:30','21:00'] local
  with_food     TEXT,                     -- 'before'|'after'|'any'
  is_priority   BOOLEAN DEFAULT false,    -- at most one per patient
  stock_count   INT
);
CREATE INDEX IF NOT EXISTS idx_meds_patient ON medications(patient_id);
-- "at most one per patient" was a comment in the TRD; make the database hold it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meds_one_priority
  ON medications(patient_id) WHERE is_priority;

-- ============ calls ============

CREATE TABLE IF NOT EXISTS call_sessions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE INDEX IF NOT EXISTS idx_sessions_patient_open
  ON call_sessions(patient_id, status) WHERE status IN ('active','dropped');

-- ============ what calls produce ============

CREATE TABLE IF NOT EXISTS dose_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES patients(id),
  medication_id   UUID NOT NULL REFERENCES medications(id),
  slot_time       TIMESTAMPTZ NOT NULL,
  call_session_id UUID REFERENCES call_sessions(id),
  status          TEXT NOT NULL,          -- 'confirmed'|'deferred'|'missed'|'no_answer'
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dose_slot ON dose_events(medication_id, slot_time);

CREATE TABLE IF NOT EXISTS observations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES patients(id),
  call_session_id UUID REFERENCES call_sessions(id),
  kind            TEXT NOT NULL,          -- 'symptom'|'mood'|'note'
  text            TEXT NOT NULL,          -- VERBATIM. never paraphrased
  severity        TEXT NOT NULL,          -- 'none'|'watch'|'red'
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_obs_patient_recent ON observations(patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intake_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE IF NOT EXISTS escalations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE IF NOT EXISTS handoffs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_record_id  UUID NOT NULL REFERENCES intake_records(id),
  token             TEXT NOT NULL UNIQUE, -- 32+ bytes, URL-safe, unguessable
  created_at        TIMESTAMPTZ DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  viewed_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id  UUID NOT NULL REFERENCES caregivers(id),
  tier          TEXT NOT NULL,            -- 'trial'|'care'|'care_plus'
  amount_inr    INT,
  payment_ref   TEXT,
  started_at    TIMESTAMPTZ DEFAULT now()
);

-- ============ caregiver auth ============
-- Not in TRD §3. The tool contract's only auth is the shared CARE_API_TOKEN
-- (TRD §15), which is server-to-server and cannot reach the browser (NFR-7).
-- These two tables are what let a caregiver prove who they are.

CREATE TABLE IF NOT EXISTS auth_otp (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      TEXT NOT NULL CHECK (channel IN ('sms','email')),
  destination  TEXT NOT NULL,          -- E.164, or lowercased email
  code_hash    BYTEA NOT NULL,         -- HMAC-SHA256(code, OTP_PEPPER). never the code
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,            -- set on success AND on the last failed try
  request_ip   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot lookup on every verify: newest unconsumed code for one destination.
-- Partial, because a consumed row is never a candidate again and the table is
-- append-only — leaving spent codes in the index would grow it without bound.
CREATE INDEX IF NOT EXISTS idx_otp_live
  ON auth_otp(channel, destination, created_at DESC) WHERE consumed_at IS NULL;

-- Rate limiting counts sends per destination and per IP inside a window.
CREATE INDEX IF NOT EXISTS idx_otp_recent ON auth_otp(destination, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_recent_ip
  ON auth_otp(request_ip, created_at DESC) WHERE request_ip IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id UUID NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  -- sha256 of the cookie value. handoffs.token is stored raw (TRD §3) because it
  -- lives 24h and grants one read-only screen; a session lives 30 days and grants
  -- the whole account, so a dump of this table must not hand over live logins.
  token_hash   BYTEA NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "log me out everywhere", and the per-caregiver session list in settings.
CREATE INDEX IF NOT EXISTS idx_sessions_caregiver
  ON auth_sessions(caregiver_id) WHERE revoked_at IS NULL;
