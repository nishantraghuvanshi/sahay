'use strict';

const { DatabaseSync } = require('node:sqlite');
const OutcomeRepositoryPort = require('../../core/ports/repository');
const logger = require('../../utils/logger');

/** States a session may be moved into once it is no longer active. */
const SESSION_END_STATES = ['completed', 'dropped', 'abandoned'];

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
        ground_truth TEXT
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
    `);
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
    return stmt.get(phone) || null;
  }

  /** @returns {Array} All patients. */
  async listPatients() {
    return this.db.prepare('SELECT * FROM patients ORDER BY id ASC').all();
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
   * @param {Object} call - { callId, useCase, language, phone, variables }
   */
  async createCall(call) {
    const stmt = this.db.prepare(`
      INSERT INTO calls (call_id, use_case, language, phone, variables)
      VALUES (?, ?, ?, ?, ?)
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
   * @param {Object} outcome - { callId, label, source, reason, transcript, duration, cost }
   */
  async save(outcome) {
    // UPSERT, not UPDATE. Nothing in the engine calls createCall(), so an
    // UPDATE here matched zero rows and discarded the outcome silently —
    // the pilot would have finished with an empty database.
    // COALESCE keeps any metadata createCall() did write.
    const stmt = this.db.prepare(`
      INSERT INTO calls (
        call_id, outcome_label, outcome_source, outcome_reason, transcript,
        duration_seconds, cost, prompt_version, parent_id, attempt_number, phone, ended_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      outcome.phone || null
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
