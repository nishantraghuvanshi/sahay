'use strict';

const { INTAKE_FIELDS } = require('./inbound-context');

/**
 * Function tool definitions for the medication adherence use case.
 *
 * report_outcome: LLM calls this once when the user's intent is clear.
 * capture_field: LLM calls this per-turn, as soon as an intake field is
 * answered — this is what makes fields_so_far non-empty for a resumed call.
 * end_call: Uses Vapi's native endCall tool (no custom definition needed).
 */

const TOOLS = [
  {
    type: 'function',
    async: false,
    function: {
      name: 'report_outcome',
      description: [
        "Call this EXACTLY ONCE per call when the user's intent is unambiguous.",
        'CONFIRMED = the user said they have ALREADY taken this dose. A promise or an intention is NOT CONFIRMED: "I will take it now", "I will take it after food", "maybe", "I think so" are DENIED or UNCLEAR, however willing the user sounded. A dose that has not been swallowed yet has not been taken.',
        'DENIED = user said they have not taken it yet.',
        'UNCLEAR = user responded but their intent could not be determined.',
        'ESCALATED_SYMPTOM = user reported a MEDICAL EMERGENCY (chest pain, difficulty breathing, severe dizziness, fainting, bleeding, a fall, sudden weakness, slurred speech, severe pain, or confusion about who/where they are). This alerts their family, so use it ONLY for an actual medical emergency.',
        'ESCALATED_DISTRESS = user expressed emotional distress, a wish to stop treatment, or thoughts of self-harm — with no physical medical emergency. This also alerts their family, so use it ONLY for actual distress, not a medical emergency.',
        'INCOMPLETE = the conversation broke down (repeated confusion) or the patient could not be reached. This is NOT a medical event.',
        'Call this BEFORE your closing sentence.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['CONFIRMED', 'DENIED', 'UNCLEAR', 'ESCALATED_SYMPTOM', 'ESCALATED_DISTRESS', 'INCOMPLETE'],
            description: 'The call outcome',
          },
          reason: {
            type: 'string',
            description: 'Brief reason for this outcome (e.g., "user confirmed taking medicine")',
          },
        },
        required: ['outcome', 'reason'],
      },
    },
  },
  {
    type: 'function',
    // capture_field fires every turn, not once at call end like
    // report_outcome — a blocking round trip here pays a pause on every turn
    // for a tool that hands the model nothing back. The response shape a
    // real Vapi call expects is unverified (see I6), so this only flips the
    // async flag rather than guessing at a `results` array.
    async: true,
    function: {
      name: 'capture_field',
      description: [
        'Call this IMMEDIATELY after every turn in which the caller answers one',
        'of the intake questions — never batch captures to the end of the call.',
        "Pass the caller's words VERBATIM: do not paraphrase, translate, or tidy them up.",
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            enum: INTAKE_FIELDS.map((f) => f.key),
            description: 'Which intake field this answer is for',
          },
          value: {
            type: 'string',
            description: "The caller's answer, verbatim",
          },
        },
        required: ['field', 'value'],
      },
    },
  },
];

module.exports = { TOOLS };
