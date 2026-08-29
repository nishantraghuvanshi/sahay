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
        'CONFIRMED = user confirmed taking medication.',
        'DENIED = user said they have not taken it yet.',
        'UNCLEAR = user responded but their intent could not be determined.',
        'ESCALATED_SYMPTOM = user reported a physical symptom. This alerts their family, so use it ONLY for an actual symptom.',
        'INCOMPLETE = the conversation broke down (repeated confusion). This is NOT a medical event.',
        'Call this BEFORE your closing sentence.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['CONFIRMED', 'DENIED', 'UNCLEAR', 'ESCALATED_SYMPTOM', 'INCOMPLETE'],
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
    async: false,
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
