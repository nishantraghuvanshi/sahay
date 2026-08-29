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
}

module.exports = OutcomeRepositoryPort;
