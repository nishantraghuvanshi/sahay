'use strict';

const { DatabaseSync } = require('node:sqlite');
const OutcomeRepositoryPort = require('../../core/ports/repository');
const logger = require('../../utils/logger');

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
    `);
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
        duration_seconds, cost, prompt_version, parent_id, attempt_number, ended_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      outcome.attemptNumber ?? null
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
