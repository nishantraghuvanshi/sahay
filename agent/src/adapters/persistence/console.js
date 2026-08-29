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
}

module.exports = ConsoleRepository;
