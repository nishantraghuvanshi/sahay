'use strict';

/**
 * Outcome Repository Port (interface)
 *
 * Persists call outcomes. Phase 0: console logger.
 * Phase 1: SQLite. Phase 2: Supabase/Postgres.
 */
class OutcomeRepositoryPort {
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
}

module.exports = OutcomeRepositoryPort;
