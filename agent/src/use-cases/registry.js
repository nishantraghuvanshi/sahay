'use strict';

/**
 * Use Case Registry
 *
 * Registers all available use cases. The server selects the active use case
 * from config or environment variables.
 *
 * To add a new use case:
 *   1. Create src/use-cases/<name>/ with strategy.js and index.js
 *   2. Import it here and add to USE_CASES
 *   3. Set USE_CASE=<name> in .env
 */

const medicationAdherence = require('./medication-adherence');

const USE_CASES = {
  'medication-adherence': medicationAdherence,
  // 'emergency-triage': require('./emergency-triage'),  // Phase 4
};

/**
 * Get a use case by name.
 * @param {string} name
 * @returns {Object} { name, strategy, plugins }
 */
function getUseCase(name) {
  const useCase = USE_CASES[name];
  if (!useCase) {
    throw new Error(
      `Unknown use case: "${name}". Available: ${Object.keys(USE_CASES).join(', ')}`
    );
  }
  return useCase;
}

/**
 * Get the active use case (from env var or default).
 * @returns {Object}
 */
function getActiveUseCase() {
  const name = process.env.USE_CASE || 'medication-adherence';
  return getUseCase(name);
}

module.exports = { USE_CASES, getUseCase, getActiveUseCase };
