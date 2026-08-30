'use strict';

/**
 * Outcome Repository Port (interface)
 *
 * Persists call outcomes. Phase 0: console logger.
 * Phase 1: SQLite. Phase 2: Supabase/Postgres.
 */
class OutcomeRepositoryPort {
  /**
   * Whether this repository actually stores anything across calls.
   *
   * Read by the persistence guard so core/ can enforce a use case's
   * persistence requirement without importing any adapter.
   *
   * @returns {boolean}
   */
  get isPersistent() {
    return false;
  }

  /**
   * Save a call outcome.
   * @param {Object} outcome - { callId, label, source, reason, transcript, duration, cost, ... }
   */
  async save(outcome) {
    throw new Error('OutcomeRepositoryPort.save() not implemented');
  }

  /**
   * Retrieve recent call outcomes.
   * @param {Object} filters - { limit, outcome, phone, ... }
   * @returns {Array} List of outcomes
   */
  async list(filters) {
    throw new Error('OutcomeRepositoryPort.list() not implemented');
  }

  // ── Call & session lifecycle ─────────────────────────────────────
  //
  // Declared here because src/core/call/lifecycle.js — the transport-agnostic
  // state machine shared by every orchestrator — depends on all of these.
  // A repository adapter that doesn't implement them fails at runtime the
  // first time a call comes in, not at wiring time.

  /**
   * Create the `calls` row for a call id, before anything else references it.
   * @param {Object} call - { callId, phone }
   */
  async createCall(call) {
    throw new Error('OutcomeRepositoryPort.createCall() not implemented');
  }

  /**
   * Open a session row for a call.
   * @param {Object} session - { sessionId, patientId, callId, direction }
   */
  async createSession(session) {
    throw new Error('OutcomeRepositoryPort.createSession() not implemented');
  }

  /**
   * Fetch the session for a call id.
   * @param {string} callId
   * @returns {Object|null}
   */
  async getSession(callId) {
    throw new Error('OutcomeRepositoryPort.getSession() not implemented');
  }

  /**
   * Merge captured intake fields onto a session.
   * @param {string} callId
   * @param {Object} fields
   */
  async updateSessionFields(callId, fields) {
    throw new Error('OutcomeRepositoryPort.updateSessionFields() not implemented');
  }

  /**
   * Close a session into its terminal status.
   * @param {string} callId
   * @param {string} status
   */
  async endSession(callId, status) {
    throw new Error('OutcomeRepositoryPort.endSession() not implemented');
  }

  /**
   * Persist one turn of call transcript.
   * @param {Object} message - { callId, role, text, ... }
   */
  async saveMessage(message) {
    throw new Error('OutcomeRepositoryPort.saveMessage() not implemented');
  }

  /**
   * Look up a patient by phone number.
   * @param {string} phone - E.164 number
   * @returns {Object|null}
   */
  async findPatientByPhone(phone) {
    throw new Error('OutcomeRepositoryPort.findPatientByPhone() not implemented');
  }

  /**
   * Create or update a patient by phone number.
   * @param {Object} patient - { phone, name, drugName, language, timezone, ... }
   */
  async upsertPatient(patient) {
    throw new Error('OutcomeRepositoryPort.upsertPatient() not implemented');
  }

  // ── Memory: the two features that are entirely persistence ───────
  //
  // Resume-after-drop and inbound context ("the call already knows") have no
  // implementation above this port — they ARE these three reads. An adapter
  // that omits them satisfies nothing while appearing to satisfy the
  // interface, which is why they are declared rather than left implicit.

  /**
   * Most recent resumable session for a patient inside the resume window.
   * @param {string} patientId
   * @param {number} windowMinutes
   * @param {Date|string} [now]
   * @returns {Object|null} The session row, or null when nothing is resumable
   */
  async findResumableSession(patientId, windowMinutes, now) {
    throw new Error('OutcomeRepositoryPort.findResumableSession() not implemented');
  }

  /**
   * Intake fields captured so far on a session.
   * @param {string} sessionId
   * @returns {Object} field name -> verbatim value
   */
  async getSessionFields(sessionId) {
    throw new Error('OutcomeRepositoryPort.getSessionFields() not implemented');
  }

  /**
   * Recent calls for a phone number, for inbound context.
   * @param {string} phone
   * @param {number} [limit]
   * @returns {Array}
   */
  async recentCallsForPhone(phone, limit) {
    throw new Error('OutcomeRepositoryPort.recentCallsForPhone() not implemented');
  }

  /**
   * Stamp that a caregiver alert was delivered, and over which channel.
   *
   * Pass 'failed' when every retry was exhausted — a dropped medical alert
   * must be visible in the data, never a silent catch. Implementations MUST
   * fail loudly when the call row does not exist rather than matching zero
   * rows quietly.
   *
   * @param {string} callId
   * @param {string} channel
   */
  async recordAlert(callId, channel) {
    throw new Error('OutcomeRepositoryPort.recordAlert() not implemented');
  }
}

module.exports = OutcomeRepositoryPort;
