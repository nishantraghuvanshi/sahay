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
  // EscalationAlertPlugin closes the loop on ESCALATED_SYMPTOM — without it
  // the highest-stakes outcome is a database row nobody reads.
  plugins: [EscalationAlertPlugin],
};
