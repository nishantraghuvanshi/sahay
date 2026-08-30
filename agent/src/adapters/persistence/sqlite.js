'use strict';

const { DatabaseSync } = require('node:sqlite');
const OutcomeRepositoryPort = require('../../core/ports/repository');
const logger = require('../../utils/logger');
const { assertFilesystemPath } = require('../../utils/db-path');
const { readSchemaSql, checkAndMigrate } = require('./schema-version');

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
/**
 * Every patient read goes through this.
 *
 * `caregiver_name` and `caregiver_phone` used to be columns on `patients`; they are
 * now a row in `caregivers`, joined and aliased back to the names callers already
 * use (inbound-context.js reads `patient.caregiver_name`). The shape above this
 * layer is unchanged — what changed is that there is one caregiver record rather
 * than a copy of the name and number on every patient.
 */
const PATIENT_SELECT = `
  SELECT p.*, c.name AS caregiver_name, c.phone_e164 AS caregiver_phone
  FROM patients p
  LEFT JOIN caregivers c ON c.id = p.caregiver_id
`;

/** Ids are TEXT uuids across the whole schema now, not per-table autoincrements. */
const newId = () => require('crypto').randomUUID();

class SqliteRepository extends OutcomeRepositoryPort {
  /**
   * @param {Object} opts
   * @param {string} [opts.dbPath] - Path to the SQLite file. Defaults to ./data/voiceagent.db
   */
  constructor(opts = {}) {
    super();
    // One database for the product, not one per lane. It used to be
    // ./data/voiceagent.db while the caregiver app wrote api/voxikin.db, and the two
    // never met: a dose moved on the calendar did not change which call was placed.
    // VOXIKIN_DB is the same variable the Python API reads, so both land on one file.
    let dbPath = opts.dbPath;
    let dbPathSource = opts.dbPathSource || null;
    if (!dbPath && process.env.VOXIKIN_DB) {
      dbPath = process.env.VOXIKIN_DB;
      dbPathSource = dbPathSource || 'VOXIKIN_DB';
    }
    if (!dbPath) {
      dbPath = require('path').join(__dirname, '..', '..', '..', '..', 'api', 'voxikin.db');
    }

    // Fail closed on a value that is evidently not a filesystem path (a
    // Postgres/MySQL/etc connection string) BEFORE anything is created —
    // see agent/postgresql:/... in this working tree for what happens
    // without this check.
    assertFilesystemPath(dbPath, dbPathSource);
    this.dbPath = dbPath;

    // Ensure the data directory exists
    const path = require('path');
    const fs = require('fs');
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    // Version check first, before any pragma that writes to the file (WAL
    // mode persists to the database header) — an incompatible database must
    // be refused having had nothing at all written to it.
    this._migrate();

    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    // Wait rather than fail when another process holds the write lock. SQLite is
    // single-writer, and seed-medications.js / ground-truth.js are both meant to
    // run against a live DB — without this they throw SQLITE_BUSY instantly
    // instead of waiting the moment they overlap with a call in progress.
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  /** @returns {boolean} SQLite stores across calls. */
  get isPersistent() {
    return true;
  }

  /**
   * Open-time schema check and migration. api/schema.sql is the single
   * authority — both the target version and the additive column list are
   * derived from it (see schema-version.js) rather than hand-maintained
   * here. Refuses to open (and writes nothing) when the database is
   * incompatible: an INTEGER primary key where the schema now says TEXT, or
   * a pre-rename column name (medications.times/food_rule) still present.
   * spec: .superpowers/sdd/modularise-boundaries/task-4-brief.md
   * @private
   */
  _migrate() {
    const schemaSql = readSchemaSql();
    const result = checkAndMigrate(this.db, schemaSql, this.dbPath);
    if (result.verdict === 'created') {
      logger.log('db_schema_created', { version: result.version });
    } else if (result.verdict === 'migrated') {
      logger.log('db_migrated', {
        from: result.from,
        to: result.version,
        added: result.added,
        skipped: result.skipped,
        skippedIndexes: result.skippedIndexes,
      });
    }
  }

  // ── Patients ────────────────────────────────────────────────────

  /**
   * Insert or update a patient, keyed on phone.
   * @param {Object} patient - { phone, name, drugName, language, caregiverName, caregiverPhone, notes }
   */
  async upsertPatient(patient) {
    // The caregiver is a row of its own now, not two columns on the patient.
    // Callers still pass caregiverName/caregiverPhone and still read back
    // `caregiver_name`/`caregiver_phone` — see the join in _patientSelect — so
    // nothing above this layer changed. What did change is that there is one
    // caregiver record instead of a copy per patient.
    const caregiverId = this._upsertCaregiver(patient.caregiverName, patient.caregiverPhone);

    const stmt = this.db.prepare(`
      INSERT INTO patients (
        id, caregiver_id, phone_e164, name, drug_name, language, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(phone_e164) DO UPDATE SET
        caregiver_id = COALESCE(excluded.caregiver_id, patients.caregiver_id),
        name         = COALESCE(excluded.name, patients.name),
        drug_name    = COALESCE(excluded.drug_name, patients.drug_name),
        language     = COALESCE(excluded.language, patients.language),
        notes        = COALESCE(excluded.notes, patients.notes),
        updated_at   = datetime('now')
    `);

    stmt.run(
      newId(),
      caregiverId,
      patient.phone,
      patient.name || null,
      patient.drugName || null,
      patient.language || 'hi-IN',
      patient.notes || null
    );

    logger.log('db_patient_upserted', { phone: patient.phone });
  }

  /**
   * Find or create the caregiver row, keyed on phone.
   *
   * Returns null when neither a name nor a phone was given: `patients.caregiver_id`
   * is nullable and an anonymous caller has no caregiver yet, which is a real state
   * rather than an error. `caregivers.phone_e164` is NOT NULL and unique, so a
   * caregiver known only by name gets a placeholder key derived from that name —
   * enough to hold one row per person without inventing a phone number.
   *
   * @private
   */
  _upsertCaregiver(name, phone) {
    if (!name && !phone) return null;
    const key = phone || `name:${name}`;

    const existing = this.db
      .prepare('SELECT id FROM caregivers WHERE phone_e164 = ?')
      .get(key);
    if (existing) {
      if (name) {
        this.db
          .prepare('UPDATE caregivers SET name = COALESCE(?, name) WHERE id = ?')
          .run(name, existing.id);
      }
      return existing.id;
    }

    const id = newId();
    this.db
      .prepare(
        `INSERT INTO caregivers (id, name, phone_e164, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .run(id, name || 'Caregiver', key);
    return id;
  }

  /**
   * Resolve a caller to a patient record.
   * @param {string} phone - E.164
   * @returns {Object|null} Never invents a record.
   */
  async findPatientByPhone(phone) {
    const stmt = this.db.prepare(`${PATIENT_SELECT} WHERE p.phone_e164 = ?`);
    const row = stmt.get(phone);
    return row ? _withDefaultTimezone(row) : null;
  }

  /**
   * Active medications for one patient, in slot order.
   *
   * Stopped and excluded rows are filtered here rather than by every caller,
   * because the consequence of leaking one is specific: the agent would tell a
   * patient about a dose call that will never come, or ask about a medicine
   * they were taken off.
   *
   * @param {string} patientId
   * @returns {Promise<Array>} rows from `medications`
   */
  async findMedicationsForPatient(patientId) {
    if (!patientId) return [];
    return this.db
      .prepare(
        `SELECT * FROM medications
         WHERE patient_id = ? AND excluded = 0 AND stopped_at IS NULL
         ORDER BY name ASC`
      )
      .all(patientId);
  }

  /** @returns {Array} All patients. */
  async listPatients() {
    const rows = this.db.prepare(`${PATIENT_SELECT} ORDER BY p.created_at ASC`).all();
    return rows.map(_withDefaultTimezone);
  }

  /**
   * Look up a patient by primary key. The scheduler's dose tick starts from
   * a dose_events row (which carries patient_id, not a phone number), so
   * findPatientByPhone doesn't fit — this is that lookup.
   * @param {number} patientId
   * @returns {Object|null}
   */
  async findPatientById(patientId) {
    const row = this.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    return row ? _withDefaultTimezone(row) : null;
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

    const row = this.db.prepare(`${PATIENT_SELECT} WHERE p.id = ?`).get(patientId);
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
             id, session_id, patient_id, call_id, direction, status, fields_so_far, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?)
           ON CONFLICT(session_id) DO NOTHING`
        )
        .run(
          newId(),
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
      .prepare(`SELECT * FROM sessions${where} ORDER BY created_at DESC, rowid DESC`)
      .all(...params);
  }

  /**
   * Close a session into a terminal (or resumable) state.
   * @param {string} sessionId
   * @param {string} status - completed | dropped | abandoned
   */
  async endSession(sessionId, status, now = new Date()) {
    if (!SESSION_END_STATES.includes(status)) {
      throw new Error(
        `Invalid session status: "${status}". Expected one of ${SESSION_END_STATES.join(', ')}`
      );
    }
    // Injectable clock, matching dueDoseEvents() and expireStaleSessions().
    // This method used to stamp real wall-clock time regardless, so any caller
    // running on an injected clock wrote an ended_at the injected clock could
    // never reason about — the two are compared directly by
    // expireStaleSessions. A test pinned to a fixed NOW therefore passed only
    // while real time happened to sit inside its window, and began failing the
    // moment it drifted out. Same clock in, same clock out.
    const nowIso = now.toISOString();
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
           -- rowid breaks ties: two sessions ending in the same millisecond
           -- share an ISO timestamp, leaving ended_at alone non-deterministic.
           -- id is a random UUID (see newId() above), not a monotonic
           -- sequence, so ordering by it does not favour the most recently
           -- inserted row -- it just picks whichever row happened to get
           -- the lexicographically larger UUID, which flips from run to
           -- run. rowid is SQLite's own insertion-order integer (this
           -- table's PRIMARY KEY is TEXT, so rowid is still implicit and
           -- available), matching the tiebreak already used by
           -- listSessions() and list() above.
           ORDER BY ended_at DESC, rowid DESC LIMIT 1`
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
        id, patient_id, name, dose, slots, with_food, start_date, end_date, stopped_at,
        confirmed_by, confirmed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(patient_id, name, start_date) DO UPDATE SET
        dose       = excluded.dose,
        slots      = excluded.slots,
        with_food  = excluded.with_food,
        end_date   = excluded.end_date,
        stopped_at = excluded.stopped_at,
        updated_at = excluded.updated_at
    `);

    // confirmed_by / confirmed_at are NOT NULL in the shared schema: FR-4 says no
    // schedule exists without a human having signed it off. A medication the agent
    // writes is attributed to the patient's own caregiver, which is who signed the
    // schedule this row belongs to.
    const confirmedBy = this.db
      .prepare('SELECT caregiver_id FROM patients WHERE id = ?')
      .get(med.patientId)?.caregiver_id ?? null;

    stmt.run(
      newId(),
      med.patientId,
      med.name,
      med.dose ?? null,
      times,
      med.foodRule ?? null,
      med.startDate,
      med.endDate ?? null,
      med.active === false ? nowIso : null,
      confirmedBy,
      nowIso,
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
    const where = opts.activeOnly ? ' AND stopped_at IS NULL' : '';
    return this.db
      .prepare(`SELECT * FROM medications WHERE patient_id = ?${where} ORDER BY id ASC`)
      .all(patientId);
  }

  /**
   * Look up a medication by primary key. The scheduler's dose tick starts
   * from a dose_events row (which carries medication_id, not a patient_id
   * to list medications under), so listMedications doesn't fit — this is
   * that lookup.
   * @param {number} medicationId
   * @returns {Object|null}
   */
  async findMedicationById(medicationId) {
    return this.db.prepare('SELECT * FROM medications WHERE id = ?').get(medicationId) || null;
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
        'SELECT * FROM calls WHERE phone = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
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
      INSERT INTO calls (id, call_id, use_case, language, phone, variables)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO NOTHING
    `);

    stmt.run(
      newId(),
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
        id, call_id, outcome_label, outcome_source, outcome_reason, transcript,
        duration_seconds, cost, prompt_version, parent_id, attempt_number, phone, recording_url, ended_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(call_id) DO UPDATE SET
        outcome_label   = COALESCE(excluded.outcome_label, calls.outcome_label),
        outcome_source  = COALESCE(excluded.outcome_source, calls.outcome_source),
        outcome_reason  = COALESCE(excluded.outcome_reason, calls.outcome_reason),
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
      newId(),
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
    const result = stmt.run(channel, callId);

    if (result.changes === 0) {
      throw new Error(`Unknown call: "${callId}"`);
    }

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

    // created_at has second precision, so rows written in the same second tie.
    // rowid breaks it by insertion order — `id DESC` used to, back when ids were
    // autoincrementing integers rather than uuids.
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
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
      INSERT INTO messages (id, call_id, role, content, tool_calls)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      newId(),
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
