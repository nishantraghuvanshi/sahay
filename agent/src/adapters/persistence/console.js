'use strict';

const OutcomeRepositoryPort = require('../../core/ports/repository');

/**
 * Console Repository
 *
 * Phase 0 persistence adapter — logs call outcomes to the console as JSON.
 * Phase 1 will replace this with SQLite; Phase 2 with Supabase/Postgres.
 */
class ConsoleRepository extends OutcomeRepositoryPort {
  /**
   * Save a call outcome by logging it to console.
   * @param {Object} outcome - { callId, label, source, reason, transcript, duration, cost, ... }
   */
  async save(outcome) {
    console.log(
      JSON.stringify({
        event: 'outcome_saved',
        timestamp: new Date().toISOString(),
        ...outcome,
      })
    );
  }

  /**
   * List recent call outcomes.
   * Phase 0: no persistence — returns empty array.
   * @param {Object} [filters] - { limit, outcome, phone, ... }
   * @returns {Array} Empty array (Phase 0)
   */
  async list(filters) {
    return [];
  }

  // ── Patient and session surface ─────────────────────────────────
  //
  // Implemented so swapping persistence never crashes on a missing method.
  // Lookups return empty rather than throwing: a use case that actually needs
  // these is blocked at boot by the persistence guard, so reaching them here
  // means persistence was genuinely optional for that use case.

  /** @returns {boolean} Nothing survives the process. */
  get isPersistent() {
    return false;
  }

  async upsertPatient(patient) {
    this._noop('patient_upsert_skipped', { phone: patient && patient.phone });
  }

  async findPatientByPhone() {
    return null;
  }

  async listPatients() {
    return [];
  }

  async createSession(session) {
    this._noop('session_create_skipped', { sessionId: session && session.sessionId });
    return null;
  }

  async getSession() {
    return null;
  }

  async listSessions() {
    return [];
  }

  async endSession(sessionId, status) {
    this._noop('session_end_skipped', { sessionId, status });
  }

  async getSessionFields() {
    return {};
  }

  async updateSessionFields(sessionId, fields) {
    this._noop('session_fields_skipped', { sessionId });
    return { ...fields };
  }

  async findResumableSession() {
    return null;
  }

  async expireStaleSessions() {
    return 0;
  }

  async recentCallsForPhone() {
    return [];
  }

  // ── Medications & dose events ────────────────────────────────────

  async upsertMedication(med) {
    this._noop('medication_upsert_skipped', {
      patientId: med && med.patientId,
      name: med && med.name,
    });
    return null;
  }

  async listMedications() {
    return [];
  }

  async upsertDoseEvent(event) {
    this._noop('dose_event_upsert_skipped', {
      medicationId: event && event.medicationId,
      slotTime: event && event.slotTime,
    });
    return null;
  }

  async setDoseStatus(medicationId, slotTime, status) {
    this._noop('dose_status_set_skipped', { medicationId, slotTime, status });
    return null;
  }

  async listDoseEvents() {
    return [];
  }

  async dueDoseEvents() {
    return [];
  }

  /**
   * Record that a write was discarded, so console mode is visible in logs
   * rather than merely quiet.
   * @private
   */
  _noop(event, details) {
    console.log(
      JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        reason: 'no persistence configured (ConsoleRepository)',
        ...details,
      })
    );
  }
}

module.exports = ConsoleRepository;
