'use strict';

/**
 * Function tool definitions for the medication adherence use case.
 *
 * report_outcome: LLM calls this once when the user's intent is clear.
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
];

module.exports = { TOOLS };
