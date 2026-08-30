'use strict';

const { DatabaseSync } = require('node:sqlite');
const OutcomeRepositoryPort = require('../../core/ports/repository');
const logger = require('../../utils/logger');

/** States a session may be moved into once it is no longer active. */
const SESSION_END_STATES = ['completed', 'dropped', 'abandoned'];

/**
 * The only valid dose_events.status values. 'unknown' is distinct from
 * 'missed' — see the schema comment on dose_events for why that distinction
 * is load-bearing rather than cosmetic.
 */
const DOSE_EVENT_STATUSES = [
  'pending',
  'confirmed',
  'deferred',
  'missed',
  'no_answer',
  'unknown',
  'skipped_with_reason',
];

/**
 * Applied at the read site, never backfilled, when patients.timezone is
 * NULL — see the schema comment on that column. spec:
 * .superpowers/sdd/scheduler/task-1-brief.md
 */
const DEFAULT_PATIENT_TIMEZONE = 'Asia/Kolkata';

/**
 * Immutable default-fill: a stored NULL timezone reads as
 * DEFAULT_PATIENT_TIMEZONE without touching the row on disk.
 * @param {Object} patientRow
 * @returns {Object} a new object, never a mutation of patientRow
 */
function _withDefaultTimezone(patientRow) {
  return { ...patientRow, timezone: patientRow.timezone || DEFAULT_PATIENT_TIMEZONE };
}

/**
 * SQLite Repository
 *
 * Phase 1 persistence adapter — stores call outcomes and conversation
 * history in a SQLite database file. Implements the same OutcomeRepositoryPort
 * interface as ConsoleRepository, so it's a drop-in replacement.
 *
 * Schema is auto-migrated on construction (CREATE TABLE IF NOT EXISTS).
 *
 * Tables:
 *   calls     — one row per conversation (callId, outcome, timestamps, metadata)
 *   messages  — conversation history (role, content, callId FK)
 */
class SqliteRepository extends OutcomeRepositoryPort {
  /**
   * @param {Object} opts
   * @param {string} [opts.dbPath] - Path to the SQLite file. Defaults to ./data/voiceagent.db
   */
  constructor(opts = {}) {
    super();
    this.dbPath = opts.dbPath || './data/voiceagent.db';

    // Ensure the data directory exists
    const path = require('path');
    const fs = require('fs');
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this._migrate();
  }

  /** @returns {boolean} SQLite stores across calls. */
  get isPersistent() {
    return true;
  }

  /**
   * Auto-migrate the database schema.
   * Uses CREATE TABLE IF NOT EXISTS so it's safe to run on every boot.
   * @private
   */
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT UNIQUE NOT NULL,
        use_case TEXT,
        language TEXT,
        phone TEXT,
        variables TEXT,
        outcome_label TEXT,
        outcome_source TEXT,
        outcome_reason TEXT,
        transcript TEXT,
        duration_seconds REAL,
        cost REAL,
        created_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        -- Pilot measurement columns (PILOT-PLAN.md §5)
        prompt_version TEXT,
        parent_id TEXT,
        attempt_number INTEGER,
        alert_sent_at TEXT,
        alert_channel TEXT,
        ground_truth TEXT,
        -- Vapi call recording URL, captured from end-of-call-report. Null
        -- when the report carried none (e.g. recording failed upstream).
        recording_url TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (call_id) REFERENCES calls(call_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_calls_outcome ON calls(outcome_label);
      CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_call ON messages(call_id);

      -- The record an inbound call is answered from. Without this, an inbound
      -- caller is a stranger and there is nothing to "already know".
      CREATE TABLE IF NOT EXISTS patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_e164 TEXT UNIQUE NOT NULL,
        name TEXT,
        drug_name TEXT,
        language TEXT,
        caregiver_name TEXT,
        caregiver_phone TEXT,
        notes TEXT,
        -- IANA zone name, e.g. "Asia/Kolkata". NULL defaults to
        -- DEFAULT_PATIENT_TIMEZONE at the read site (findPatientByPhone /
        -- listPatients) rather than being backfilled here.
        timezone TEXT,
        -- ISO-8601 UTC, set by setPatientSchedule(). NULL means no call is
        -- ever placed for this patient's schedule — a refusal for the
        -- scheduler to act on, not a warning. Left unset here (not
        -- backfilled) so a patient seeded before sign-off existed stays
        -- correctly un-signed-off rather than silently granted consent.
        schedule_signed_off_at TEXT,
        -- JSON array of {"start":"HH:MM","end":"HH:MM"}, patient-local, e.g.
        -- caregiver-declared do-not-call hours. Stored and read as a raw
        -- JSON string — never parsed at this layer — matching how
        -- medications.times is handled; the caller parses it.
        quiet_windows TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      );

      -- Session state machine:
      --   active ──normal end──► completed
      --      │
      --   disconnect ──► dropped ──redial in window──► active
      --                     │
      --             window expires ──► abandoned
      --
      -- Timestamps here are ISO-8601 UTC written from JS, NOT sqlite
      -- datetime('now'), so the resume window can be compared against an
      -- injected clock and tested without sleeping.
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        patient_id INTEGER,
        call_id TEXT,
        direction TEXT,
        status TEXT NOT NULL,
        fields_so_far TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        ended_at TEXT,
        FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      -- Resume lookup runs before the agent's first word, inside Vapi's
      -- 7.5s assistant-request budget. It must not scan call history.
      CREATE INDEX IF NOT EXISTS idx_sessions_patient_status
        ON sessions(patient_id, status);
      CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);

      -- A patient's standing drug schedule, seeded by hand today (the
      -- caregiver app's OCR pipeline that will populate this is a separate
      -- lane and is not ready). One row per medication, not per dose.
      --
      -- times: JSON array of "HH:MM" 24h strings, e.g. '["08:00","20:00"]'.
      -- A medication is taken at a fixed set of times of day, repeated once
      -- per day between start_date and end_date — not a fixed list of
      -- absolute timestamps (those belong to dose_events, one row each,
      -- generated from this). JSON keeps the column schema-free as dose
      -- counts vary per medication, and sqlite's json_each can expand it
      -- when a script needs to materialize dose_events from it.
      CREATE TABLE IF NOT EXISTS medications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        dose TEXT,
        times TEXT NOT NULL,
        food_rule TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        -- 0/1. A priority medication overrides a caregiver's do-not-call
        -- quiet window — see the scheduling policy that reads this.
        is_priority INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      -- A scheduler will list a patient's active medications on every poll;
      -- this is that lookup.
      CREATE INDEX IF NOT EXISTS idx_medications_patient_active
        ON medications(patient_id, active);

      -- upsertMedication is idempotent on (patient_id, name, start_date):
      -- re-running the hand seed script with an updated dose/times for the
      -- same drug/regimen must update the existing row, not create a second
      -- medication. start_date (not just name) is part of the key so a
      -- taper — the same drug prescribed twice with different start_dates
      -- as its dose steps down over time — is representable as two rows
      -- instead of being silently merged into one. start_date is NOT NULL
      -- above, so there is no null-collapsing case to handle here.
      --
      -- This replaces an earlier idx_medications_patient_name unique index
      -- on (patient_id, name) alone, which could not represent a taper.
      -- CREATE INDEX IF NOT EXISTS never redefines an existing index of the
      -- same name, so the old index is dropped by name before recreating —
      -- otherwise a database migrated from before this change would keep
      -- enforcing the old, incorrect constraint alongside the new one.
      DROP INDEX IF EXISTS idx_medications_patient_name;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_medications_patient_name_start
        ON medications(patient_id, name, start_date);

      -- One row per scheduled dose occurrence, generated ahead of time from
      -- a medication's times. This is the ledger a caregiver-app number
      -- like "3 of 5 doses taken" is computed from, and what a future
      -- scheduler polls to decide who to call next.
      --
      -- status: pending | confirmed | deferred | missed | no_answer |
      --         unknown | skipped_with_reason
      --
      -- 'unknown' is distinct from 'missed': when the agent could not reach
      -- the patient at all (no_answer exhausted retries, or the call itself
      -- never connected), the truth is that whether the dose was taken is
      -- unknown — not that it was skipped. Recording that as 'missed' would
      -- be a false clinical claim surfaced in the caregiver's UI ("missed
      -- dose" implies the patient was asked and didn't take it). 'unknown'
      -- keeps that uncertainty honest downstream.
      --
      -- Timestamps are ISO-8601 UTC written from JS, matching sessions,
      -- so dueDoseEvents can take an injected clock and be tested without
      -- sleeping.
      CREATE TABLE IF NOT EXISTS dose_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medication_id INTEGER NOT NULL,
        patient_id INTEGER NOT NULL,
        slot_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        actor TEXT,
        confirmed_at TEXT,
        call_id TEXT,
        -- Retry bookkeeping, written by recordDoseAttempt(). The initial
        -- dial at slot_time plus retries counts up from here; the policy
        -- that decides when attempt_count hits its ceiling lives outside
        -- this repository.
        attempt_count INTEGER DEFAULT 0,
        -- ISO-8601 UTC; when the next attempt becomes eligible. dueDoseEvents
        -- excludes a row whose next_attempt_at is still in the future, so a
        -- dose already dialled once is not picked up again before its retry
        -- offset has elapsed.
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE,
        FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      -- The single most important index in this schema: a retried or
      -- duplicated call (Vapi retries, a re-run seed, a scheduler double
      -- fire) must never double-log the same scheduled dose. upsertDoseEvent
      -- relies on this to be idempotent on (medication_id, slot_time).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dose_events_medication_slot
        ON dose_events(medication_id, slot_time);

      -- listDoseEvents filters by patient and a slot_time range; dueDoseEvents
      -- filters pending rows by slot_time. Both run against this pair.
      CREATE INDEX IF NOT EXISTS idx_dose_events_patient_slot
        ON dose_events(patient_id, slot_time);
      CREATE INDEX IF NOT EXISTS idx_dose_events_status_slot
        ON dose_events(status, slot_time);
    `);

    // CREATE TABLE IF NOT EXISTS never alters a table that already exists,
    // so a database created before recording_url was added needs an
    // explicit ALTER TABLE here. _ensureColumn is idempotent — a fresh
    // database already has the column from the CREATE TABLE above, so this
    // is a no-op there.
    this._ensureColumn('calls', 'recording_url', 'TEXT');
    this._ensureColumn('patients', 'timezone', 'TEXT');
    this._ensureColumn('patients', 'schedule_signed_off_at', 'TEXT');
    this._ensureColumn('patients', 'quiet_windows', 'TEXT');
    this._ensureColumn('medications', 'is_priority', 'INTEGER DEFAULT 0');
    this._ensureColumn('dose_events', 'attempt_count', 'INTEGER DEFAULT 0');
    this._ensureColumn('dose_events', 'next_attempt_at', 'TEXT');
  }

  /**
   * Add a column to an existing table if it isn't already there. Safe to
   * call on every boot: checks PRAGMA table_info before altering, so it
   * never re-adds a column (which would throw) or touches a fresh database
   * that was created with the column already in its CREATE TABLE.
   *
   * table/column are always internal literals passed by _migrate(), never
   * external input, so the interpolation below is not an injection risk.
   *
   * @param {string} table
   * @param {string} column
   * @param {string} type - SQLite column type, e.g. 'TEXT'
   * @private
   */
  _ensureColumn(table, column, type) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = columns.some((c) => c.name === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.log('db_column_added', { table, column });
    }
  }

  // ── Patients ────────────────────────────────────────────────────

  /**
   * Insert or update a patient, keyed on phone.
   * @param {Object} patient - { phone, name, drugName, language, caregiverName, caregiverPhone, notes }
   */
  async upsertPatient(patient) {
    const stmt = this.db.prepare(`
      INSERT INTO patients (
        phone_e164, name, drug_name, language, caregiver_name, caregiver_phone, notes, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(phone_e164) DO UPDATE SET
        name            = COALESCE(excluded.name, patients.name),
        drug_name       = COALESCE(excluded.drug_name, patients.drug_name),
        language        = COALESCE(excluded.language, patients.language),
        caregiver_name  = COALESCE(excluded.caregiver_name, patients.caregiver_name),
        caregiver_phone = COALESCE(excluded.caregiver_phone, patients.caregiver_phone),
        notes           = COALESCE(excluded.notes, patients.notes),
        updated_at      = datetime('now')
    `);

    stmt.run(
      patient.phone,
      patient.name || null,
      patient.drugName || null,
      patient.language || null,
      patient.caregiverName || null,
      patient.caregiverPhone || null,
      patient.notes || null
    );

    logger.log('db_patient_upserted', { phone: patient.phone });
  }

  /**
   * Resolve a caller to a patient record.
   * @param {string} phone - E.164
   * @returns {Object|null} Never invents a record.
   */
  async findPatientByPhone(phone) {
    const stmt = this.db.prepare('SELECT * FROM patients WHERE phone_e164 = ?');
    const row = stmt.get(phone);
    return row ? _withDefaultTimezone(row) : null;
  }

  /** @returns {Array} All patients. */
  async listPatients() {
    const rows = this.db.prepare('SELECT * FROM patients ORDER BY id ASC').all();
    return rows.map(_withDefaultTimezone);
  }

  /**
   * Set the scheduling gate on a patient: sign-off, quiet windows, and
   * timezone. CRUD only — no policy. Whether an unsigned-off schedule
   * blocks a dial, and whether a quiet window is honoured, both live in
   * the scheduling policy that reads these columns, not here.
   *
   * Partial patch, not full replace: only the keys actually present in
   * `updates` are written, so calling this with just `{ signedOffAt }`
   * leaves quietWindows/timezone untouched. This is a dynamic SET clause
   * (like listDoseEvents' dynamic WHERE) rather than upsertPatient's
   * COALESCE-on-every-column approach, because COALESCE cannot tell an
   * omitted field from an explicit `null` — and revoking sign-off
   * (signedOffAt: null) must be possible.
   *
   * Throws when no row matches rather than silently no-opping — the same
   * lesson as endSession()/setDoseStatus() above.
   *
   * @param {number} patientId
   * @param {Object} updates - { signedOffAt, quietWindows, timezone }
   *   signedOffAt: ISO-8601 UTC string, or null to revoke sign-off.
   *   quietWindows: array of {start,end} "HH:MM" objects, or null to clear.
   *     Stored as a JSON string; not parsed back out here (see the schema
   *     comment on quiet_windows).
   *   timezone: IANA zone name, or null.
   * @returns {Object} The updated patient row
   */
  async setPatientSchedule(patientId, updates = {}) {
    const sets = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(updates, 'signedOffAt')) {
      sets.push('schedule_signed_off_at = ?');
      params.push(updates.signedOffAt ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'quietWindows')) {
      sets.push('quiet_windows = ?');
      params.push(updates.quietWindows == null ? null : JSON.stringify(updates.quietWindows));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'timezone')) {
      sets.push('timezone = ?');
      params.push(updates.timezone ?? null);
    }

    if (sets.length === 0) {
      throw new Error(
        'setPatientSchedule requires at least one of signedOffAt, quietWindows, timezone'
      );
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(patientId);

    const result = this.db
      .prepare(`UPDATE patients SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);

    if (result.changes === 0) {
      throw new Error(`Unknown patient: ${patientId}`);
    }

    logger.log('db_patient_schedule_set', {
      patientId,
      signedOff: Object.prototype.hasOwnProperty.call(updates, 'signedOffAt')
        ? updates.signedOffAt != null
        : undefined,
    });

    const row = this.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    return _withDefaultTimezone(row);
  }

  // ── Sessions ────────────────────────────────────────────────────

  /**
   * Open a session, enforcing at most one active session per patient.
   *
   * A new call arriving means any earlier session is no longer live, so the
   * previous active one is marked dropped rather than rejected — that is also
   * what makes it eligible for resume.
   *
   * The demote and the insert run in one transaction, and the insert is
   * idempotent on session_id (ON CONFLICT DO NOTHING): a duplicate
   * assistant-request for the same call.id — Vapi retries after its 7.5s
   * budget lapses — calls this twice with the same sessionId. Without the
   * transaction, a throw from the second INSERT (session_id is UNIQUE) would
   * leave the first demote committed alone, and without the session_id
   * exclusion below, the second call's own demote step would find its own
   * just-inserted row (same patient, status active) and drop it out from
   * under the still-live call.
   *
   * @param {Object} session - { sessionId, patientId, callId, direction }
   * @returns {Object} The created session row
   */
  async createSession(session) {
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN');
    try {
      if (session.patientId != null) {
        this.db
          .prepare(
            `UPDATE sessions SET status = 'dropped', ended_at = updated_at, updated_at = ?
             WHERE patient_id = ? AND status = 'active' AND session_id != ?`
          )
          .run(nowIso, session.patientId, session.sessionId);
      }

      this.db
        .prepare(
          `INSERT INTO sessions (
             session_id, patient_id, call_id, direction, status, fields_so_far, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?)
           ON CONFLICT(session_id) DO NOTHING`
        )
        .run(
          session.sessionId,
          session.patientId ?? null,
          session.callId || null,
          session.direction || null,
          nowIso,
          nowIso
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    logger.log('db_session_created', {
      sessionId: session.sessionId,
      direction: session.direction,
    });

    return this.getSession(session.sessionId);
  }

  /**
   * @param {string} sessionId
   * @returns {Object|null}
   */
  async getSession(sessionId) {
    return this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) || null;
  }

  /**
   * @param {Object} [filters] - { patientId, status }
   * @returns {Array}
   */
  async listSessions(filters = {}) {
    const conditions = [];
    const params = [];
    if (filters.patientId != null) {
      conditions.push('patient_id = ?');
      params.push(filters.patientId);
    }
    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM sessions${where} ORDER BY created_at DESC`)
      .all(...params);
  }

  /**
   * Close a session into a terminal (or resumable) state.
   * @param {string} sessionId
   * @param {string} status - completed | dropped | abandoned
   */
  async endSession(sessionId, status) {
    if (!SESSION_END_STATES.includes(status)) {
      throw new Error(
        `Invalid session status: "${status}". Expected one of ${SESSION_END_STATES.join(', ')}`
      );
    }
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE session_id = ?')
      .run(status, nowIso, nowIso, sessionId);

    if (result.changes === 0) {
      throw new Error(`Unknown session: "${sessionId}"`);
    }
    logger.log('db_session_ended', { sessionId, status });
  }

  /**
   * @param {string} sessionId
   * @returns {Object} Fields captured so far, {} when none.
   */
  async getSessionFields(sessionId) {
    const row = await this.getSession(sessionId);
    if (!row) throw new Error(`Unknown session: "${sessionId}"`);
    return row.fields_so_far ? JSON.parse(row.fields_so_far) : {};
  }

  /**
   * Merge newly captured fields into the session.
   *
   * Merges rather than replaces, and throws on an unknown session: an UPDATE
   * that matches zero rows is how this codebase previously lost a pilot's
   * worth of outcomes, and losing intake fields mid-call is the same bug.
   *
   * The merge itself happens inside the UPDATE via json_patch, not as a
   * separate read-then-write in JS: two captures from one parallel model
   * turn each issue their own UPDATE against the row sqlite has at the time
   * it runs, so both survive. A read in JS followed by a write one `await`
   * later can interleave with the other capture's write and lose it.
   *
   * @param {string} sessionId
   * @param {Object} fields
   * @returns {Object} The merged fields
   */
  async updateSessionFields(sessionId, fields) {
    const result = this.db
      .prepare(
        `UPDATE sessions SET fields_so_far = json_patch(fields_so_far, ?), updated_at = ?
         WHERE session_id = ?`
      )
      .run(JSON.stringify(fields), new Date().toISOString(), sessionId);

    if (result.changes === 0) {
      throw new Error(`Unknown session: "${sessionId}"`);
    }
    return this.getSessionFields(sessionId);
  }

  /**
   * The most recent dropped session for a patient still inside the window.
   *
   * @param {number} patientId
   * @param {number} windowMinutes
   * @param {Date} [now] - Injected clock; defaults to wall time
   * @returns {Object|null}
   */
  async findResumableSession(patientId, windowMinutes, now = new Date()) {
    const cutoff = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE patient_id = ? AND status = 'dropped' AND ended_at >= ?
           -- id breaks ties: two sessions ending in the same millisecond
           -- share an ISO timestamp, leaving ended_at alone non-deterministic.
           ORDER BY ended_at DESC, id DESC LIMIT 1`
        )
        .get(patientId, cutoff) || null
    );
  }

  /**
   * Move dropped sessions past the window to abandoned.
   * @param {number} windowMinutes
   * @param {Date} [now] - Injected clock
   * @returns {number} Rows expired
   */
  async expireStaleSessions(windowMinutes, now = new Date()) {
    const cutoff = new Date(now.getTime() - windowMinutes * 60_000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'abandoned', updated_at = ?
         WHERE status = 'dropped' AND ended_at < ?`
      )
      .run(new Date().toISOString(), cutoff);

    if (result.changes > 0) {
      logger.log('db_sessions_expired', { count: result.changes, windowMinutes });
    }
    return result.changes;
  }

  // ── Medications ─────────────────────────────────────────────────

  /**
   * Insert or update a medication, keyed on (patientId, name, startDate).
   * Overwrites every field on conflict — this is a full replace, not a
   * partial patch, so re-running the seed script with a corrected
   * dose/times/food_rule for the same regimen always leaves the row
   * matching what was just passed in.
   *
   * start_date is part of the identity key (not just name) so a taper — the
   * same drug prescribed twice with different start_dates as its dose steps
   * down over time — persists as two rows instead of being silently merged
   * into one. Re-seeding the identical regimen (same patient, name and
   * start_date) still collapses to a single, updated row.
   *
   * @param {Object} med - { patientId, name, dose, times, foodRule,
   *   startDate, endDate, active }
   *   times: array of "HH:MM" strings, e.g. ['08:00', '20:00'].
   *   startDate: required (schema is NOT NULL) — passing null/undefined
   *   throws rather than silently coalescing to some default.
   * @returns {Object} The stored row
   */
  async upsertMedication(med) {
    const nowIso = new Date().toISOString();
    const times = Array.isArray(med.times) ? JSON.stringify(med.times) : med.times;

    const stmt = this.db.prepare(`
      INSERT INTO medications (
        patient_id, name, dose, times, food_rule, start_date, end_date, active, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(patient_id, name, start_date) DO UPDATE SET
        dose       = excluded.dose,
        times      = excluded.times,
        food_rule  = excluded.food_rule,
        end_date   = excluded.end_date,
        active     = excluded.active,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      med.patientId,
      med.name,
      med.dose ?? null,
      times,
      med.foodRule ?? null,
      med.startDate,
      med.endDate ?? null,
      med.active === false ? 0 : 1,
      nowIso,
      nowIso
    );

    logger.log('db_medication_upserted', {
      patientId: med.patientId,
      name: med.name,
      startDate: med.startDate,
    });
    return this.db
      .prepare('SELECT * FROM medications WHERE patient_id = ? AND name = ? AND start_date = ?')
      .get(med.patientId, med.name, med.startDate);
  }

  /**
   * @param {number} patientId
   * @param {Object} [opts] - { activeOnly }
   * @returns {Array}
   */
  async listMedications(patientId, opts = {}) {
    const where = opts.activeOnly ? ' AND active = 1' : '';
    return this.db
      .prepare(`SELECT * FROM medications WHERE patient_id = ?${where} ORDER BY id ASC`)
      .all(patientId);
  }

  // ── Dose Events ─────────────────────────────────────────────────

  /**
   * Insert or update a scheduled dose occurrence, idempotent on
   * (medicationId, slotTime) via the UNIQUE index — a retried or duplicated
   * call must never double-log a dose. Fields left unset on a repeat call
   * (e.g. a re-run of the seed script that only supplies status: 'pending')
   * do not clobber a status/actor/confirmation a live call already recorded.
   *
   * @param {Object} event - { medicationId, patientId, slotTime, status,
   *   actor, confirmedAt, callId }
   * @returns {Object} The stored row
   */
  async upsertDoseEvent(event) {
    const nowIso = new Date().toISOString();
    // status needs two placeholders: the insert-time value defaults an
    // unspecified status to 'pending' (the column is NOT NULL, so a bound
    // NULL would violate the constraint), while the conflict-time value
    // stays raw NULL-or-status so COALESCE can fall back to the row's
    // existing status rather than re-defaulting to 'pending' on every
    // repeat call.
    const rawStatus = event.status ?? null;
    const stmt = this.db.prepare(`
      INSERT INTO dose_events (
        medication_id, patient_id, slot_time, status, actor, confirmed_at, call_id, created_at, updated_at
      )
      VALUES (?, ?, ?, COALESCE(?, 'pending'), ?, ?, ?, ?, ?)
      ON CONFLICT(medication_id, slot_time) DO UPDATE SET
        status       = COALESCE(?, dose_events.status),
        actor        = COALESCE(excluded.actor, dose_events.actor),
        confirmed_at = COALESCE(excluded.confirmed_at, dose_events.confirmed_at),
        call_id      = COALESCE(excluded.call_id, dose_events.call_id),
        updated_at   = excluded.updated_at
    `);

    stmt.run(
      event.medicationId,
      event.patientId,
      event.slotTime,
      rawStatus,
      event.actor ?? null,
      event.confirmedAt ?? null,
      event.callId ?? null,
      nowIso,
      nowIso,
      rawStatus
    );

    logger.log('db_dose_event_upserted', {
      medicationId: event.medicationId,
      slotTime: event.slotTime,
    });
    return this._getDoseEvent(event.medicationId, event.slotTime);
  }

  /**
   * Delete a still-pending dose_events row by its natural key. Used only
   * by the seed script to remove the row a medication's slot generated
   * under the pre-fix bug (local "HH:MM" stamped directly as UTC) once the
   * corrected UTC instant is recomputed for the same local slot — see
   * generateSlots() in scripts/seed-medications.js. (medication_id,
   * slot_time) is unique, so the corrected time lands as a new row rather
   * than updating the stale one, and only a 'pending' row is ever removed
   * here: a dose that was actually acted on is call history, never
   * deleted by a re-seed.
   *
   * @param {number} medicationId
   * @param {string} slotTime
   * @returns {boolean} true if a row was deleted
   */
  async deleteStalePendingDoseEvent(medicationId, slotTime) {
    const result = this.db
      .prepare(
        `DELETE FROM dose_events WHERE medication_id = ? AND slot_time = ? AND status = 'pending'`
      )
      .run(medicationId, slotTime);
    return result.changes > 0;
  }

  /**
   * Set the status of an existing dose event, identified by
   * (medicationId, slotTime).
   *
   * Throws when no row matches rather than silently no-opping — the same
   * lesson as endSession()/updateSessionFields() above: an UPDATE matching
   * zero rows must never look like a successful write. Callers that are
   * genuinely unsure whether the row exists yet should call
   * upsertDoseEvent() first.
   *
   * @param {number} medicationId
   * @param {string} slotTime
   * @param {string} status - one of DOSE_EVENT_STATUSES
   * @param {Object} [opts] - { actor, callId, confirmedAt }
   * @returns {Object} The updated row
   */
  async setDoseStatus(medicationId, slotTime, status, opts = {}) {
    if (!DOSE_EVENT_STATUSES.includes(status)) {
      throw new Error(
        `Invalid dose event status: "${status}". Expected one of ${DOSE_EVENT_STATUSES.join(', ')}`
      );
    }
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE dose_events SET status = ?, actor = ?, call_id = ?, confirmed_at = ?, updated_at = ?
         WHERE medication_id = ? AND slot_time = ?`
      )
      .run(
        status,
        opts.actor ?? null,
        opts.callId ?? null,
        opts.confirmedAt ?? null,
        nowIso,
        medicationId,
        slotTime
      );

    if (result.changes === 0) {
      throw new Error(`Unknown dose event: medication ${medicationId} at ${slotTime}`);
    }

    logger.log('db_dose_status_set', { medicationId, slotTime, status, actor: opts.actor });
    return this._getDoseEvent(medicationId, slotTime);
  }

  /**
   * Record that a dial attempt was made against a dose, identified by
   * (medicationId, slotTime). CRUD only: writes exactly the callId,
   * attemptCount and nextAttemptAt it is given — the retry arithmetic
   * (when to give up, what the next offset is) is the scheduling policy's
   * job, not this repository's. Does not touch `status`; recording an
   * attempt is not a resolution.
   *
   * Throws when no row matches rather than silently no-opping — the same
   * lesson as setDoseStatus() above: a scheduler that believes an attempt
   * was recorded when it wasn't will keep re-dialling the same dose.
   *
   * @param {number} medicationId
   * @param {string} slotTime
   * @param {Object} [opts] - { callId, attemptCount, nextAttemptAt, now }
   *   now: injected clock for updated_at; defaults to wall time.
   * @returns {Object} The updated dose event row
   */
  async recordDoseAttempt(medicationId, slotTime, opts = {}) {
    const nowIso = (opts.now || new Date()).toISOString();
    const result = this.db
      .prepare(
        `UPDATE dose_events SET call_id = ?, attempt_count = ?, next_attempt_at = ?, updated_at = ?
         WHERE medication_id = ? AND slot_time = ?`
      )
      .run(
        opts.callId ?? null,
        opts.attemptCount ?? null,
        opts.nextAttemptAt ?? null,
        nowIso,
        medicationId,
        slotTime
      );

    if (result.changes === 0) {
      throw new Error(`Unknown dose event: medication ${medicationId} at ${slotTime}`);
    }

    logger.log('db_dose_attempt_recorded', {
      medicationId,
      slotTime,
      attemptCount: opts.attemptCount,
      nextAttemptAt: opts.nextAttemptAt,
    });
    return this._getDoseEvent(medicationId, slotTime);
  }

  /**
   * @param {Object} [filters] - { patientId, from, to, status }
   *   from/to bound slot_time (inclusive), as ISO-8601 strings.
   * @returns {Array}
   */
  async listDoseEvents(filters = {}) {
    const conditions = [];
    const params = [];
    if (filters.patientId != null) {
      conditions.push('patient_id = ?');
      params.push(filters.patientId);
    }
    if (filters.from) {
      conditions.push('slot_time >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push('slot_time <= ?');
      params.push(filters.to);
    }
    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM dose_events${where} ORDER BY slot_time ASC`)
      .all(...params);
  }

  /**
   * Pending dose events whose slot_time has arrived — what a scheduler will
   * later poll to decide who to call next. Also excludes a row whose
   * next_attempt_at is still in the future: that row was already dialled
   * once (recordDoseAttempt), and its retry offset hasn't elapsed yet, so
   * it is not due again.
   *
   * @param {Date} now - Injected clock, so this is testable without sleeping.
   * @param {Object} [opts] - { withinMinutes } - when set, also excludes
   *   events that became due more than withinMinutes ago, so a scheduler
   *   outage doesn't surface an unbounded backlog of ancient pending rows.
   * @returns {Array}
   */
  async dueDoseEvents(now, opts = {}) {
    const nowIso = now.toISOString();
    const params = ['pending', nowIso];
    let sql = 'SELECT * FROM dose_events WHERE status = ? AND slot_time <= ?';

    if (opts.withinMinutes != null) {
      const cutoff = new Date(now.getTime() - opts.withinMinutes * 60_000).toISOString();
      sql += ' AND slot_time >= ?';
      params.push(cutoff);
    }
    sql += ' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)';
    params.push(nowIso);
    sql += ' ORDER BY slot_time ASC';

    return this.db.prepare(sql).all(...params);
  }

  /**
   * @private
   */
  async _getDoseEvent(medicationId, slotTime) {
    return this.db
      .prepare('SELECT * FROM dose_events WHERE medication_id = ? AND slot_time = ?')
      .get(medicationId, slotTime);
  }

  /**
   * Recent calls for a caller, newest first — the "what you said last time"
   * half of the inbound context.
   *
   * @param {string} phone
   * @param {number} [limit=3] - Kept small; this runs inside the 7.5s budget
   * @returns {Array}
   */
  async recentCallsForPhone(phone, limit = 3) {
    return this.db
      .prepare(
        'SELECT * FROM calls WHERE phone = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      )
      .all(phone, Math.min(limit, 20));
  }

  /**
   * Create a call record when a conversation starts.
   *
   * Idempotent on call_id (ON CONFLICT DO NOTHING): a retried
   * assistant-request or a resumed session calls this again with the same
   * call id, and that must not throw against the UNIQUE constraint or
   * clobber outcome fields an in-flight save() may already have written.
   *
   * @param {Object} call - { callId, useCase, language, phone, variables }
   */
  async createCall(call) {
    const stmt = this.db.prepare(`
      INSERT INTO calls (call_id, use_case, language, phone, variables)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO NOTHING
    `);

    stmt.run(
      call.callId,
      call.useCase || null,
      call.language || null,
      call.phone || null,
      call.variables ? JSON.stringify(call.variables) : null
    );

    logger.log('db_call_created', { callId: call.callId });
  }

  /**
   * Save a call outcome (called when conversation ends).
   * @param {Object} outcome - { callId, label, source, reason, transcript, duration, cost, recordingUrl }
   */
  async save(outcome) {
    // UPSERT, not UPDATE. Nothing in the engine calls createCall(), so an
    // UPDATE here matched zero rows and discarded the outcome silently —
    // the pilot would have finished with an empty database.
    // COALESCE keeps any metadata createCall() did write.
    const stmt = this.db.prepare(`
      INSERT INTO calls (
        call_id, outcome_label, outcome_source, outcome_reason, transcript,
        duration_seconds, cost, prompt_version, parent_id, attempt_number, phone, recording_url, ended_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(call_id) DO UPDATE SET
        outcome_label   = excluded.outcome_label,
        outcome_source  = excluded.outcome_source,
        outcome_reason  = excluded.outcome_reason,
        transcript      = COALESCE(excluded.transcript, calls.transcript),
        duration_seconds= COALESCE(excluded.duration_seconds, calls.duration_seconds),
        cost            = COALESCE(excluded.cost, calls.cost),
        prompt_version  = COALESCE(excluded.prompt_version, calls.prompt_version),
        parent_id       = COALESCE(excluded.parent_id, calls.parent_id),
        attempt_number  = COALESCE(excluded.attempt_number, calls.attempt_number),
        phone           = COALESCE(excluded.phone, calls.phone),
        recording_url   = COALESCE(excluded.recording_url, calls.recording_url),
        ended_at        = datetime('now')
    `);

    stmt.run(
      outcome.callId,
      outcome.label || null,
      outcome.source || null,
      outcome.reason || null,
      outcome.transcript || null,
      outcome.duration ?? null,
      outcome.cost ?? null,
      outcome.promptVersion || null,
      outcome.parentId || null,
      outcome.attemptNumber ?? null,
      outcome.phone || null,
      outcome.recordingUrl || null
    );

    logger.log('db_outcome_saved', {
      callId: outcome.callId,
      label: outcome.label,
      promptVersion: outcome.promptVersion,
    });
  }

  /**
   * Stamp when an escalation alert was dispatched, and over which channel.
   * Pass 'failed' as the channel when every retry was exhausted — a dropped
   * medical alert must be visible in the data, never a silent catch.
   *
   * @param {string} callId
   * @param {string} channel - telegram | whatsapp | none | failed
   */
  async recordAlert(callId, channel) {
    const stmt = this.db.prepare(`
      UPDATE calls SET alert_sent_at = datetime('now'), alert_channel = ? WHERE call_id = ?
    `);
    stmt.run(channel, callId);
    logger.log('db_alert_recorded', { callId, channel });
  }

  /**
   * Retrieve recent call outcomes.
   * @param {Object} [filters] - { limit, outcome, phone }
   * @returns {Array} List of call records
   */
  async list(filters = {}) {
    const limit = Math.min(filters.limit || 50, 500);
    let sql = 'SELECT * FROM calls';
    const conditions = [];
    const params = [];

    if (filters.outcome) {
      conditions.push('outcome_label = ?');
      params.push(filters.outcome);
    }
    if (filters.phone) {
      conditions.push('phone = ?');
      params.push(filters.phone);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  /**
   * Get a single call by callId.
   * @param {string} callId
   * @returns {Object|null}
   */
  async getCall(callId) {
    const stmt = this.db.prepare('SELECT * FROM calls WHERE call_id = ?');
    return stmt.get(callId) || null;
  }

  /**
   * Record a human's judgement of what actually happened on a call, so an
   * automated outcome can later be measured against it.
   *
   * Throws on an unknown call id rather than silently matching zero rows —
   * the same lesson as endSession()/setDoseStatus() above: an UPDATE that
   * matches nothing must never look like a successful write.
   *
   * @param {string} callId
   * @param {string} groundTruth - Free-text human judgement of the outcome
   * @returns {Object} The updated call row
   */
  async setGroundTruth(callId, groundTruth) {
    const result = this.db
      .prepare('UPDATE calls SET ground_truth = ? WHERE call_id = ?')
      .run(groundTruth, callId);

    if (result.changes === 0) {
      throw new Error(`Unknown call: "${callId}"`);
    }

    logger.log('db_ground_truth_set', { callId, groundTruth });
    return this.getCall(callId);
  }

  /**
   * Save a conversation message.
   * @param {Object} message - { callId, role, content, toolCalls }
   */
  async saveMessage(message) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (call_id, role, content, tool_calls)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      message.callId,
      message.role,
      message.content || null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null
    );
  }

  /**
   * Get conversation history for a call.
   * @param {string} callId
   * @returns {Array} List of messages
   */
  async getMessages(callId) {
    const stmt = this.db.prepare(
      'SELECT * FROM messages WHERE call_id = ? ORDER BY created_at ASC'
    );
    return stmt.all(callId);
  }

  /**
   * Close the database connection.
   */
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = SqliteRepository;
module.exports.SESSION_END_STATES = SESSION_END_STATES;
module.exports.DOSE_EVENT_STATUSES = DOSE_EVENT_STATUSES;
