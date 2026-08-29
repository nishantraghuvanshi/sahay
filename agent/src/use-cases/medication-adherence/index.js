'use strict';

const MedicationAdherenceStrategy = require('./strategy');
const EscalationAlertPlugin = require('./plugins/escalation-alert');

/**
 * Medication Adherence Use Case Plugin
 *
 * This is the entry point for the medication adherence use case.
 * It exports the strategy and registers any use-case-specific plugins.
 *
 * To add a new use case (e.g., emergency triage):
 *   1. Create src/use-cases/emergency-triage/
 *   2. Implement a ConversationStrategy
 *   3. Create an index.js like this one
 *   4. Register it in src/use-cases/registry.js
 */

module.exports = {
  name: 'medication-adherence',
  strategy: MedicationAdherenceStrategy,
  // Inbound context and resume-after-drop read back prior state, so this
  // use case is incorrect rather than merely degraded without a database.
  requiresPersistence: true,
  // EscalationAlertPlugin closes the loop on ESCALATED_SYMPTOM and
  // ESCALATED_DISTRESS — without it the highest-stakes outcomes are a
  // database row nobody reads.
  plugins: [EscalationAlertPlugin],
};
