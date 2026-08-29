'use strict';

/**
 * Domain Event Types
 *
 * These are the events that flow through the conversation engine's event bus.
 * Every orchestrator adapter translates its native events into these domain events.
 * The conversation engine, strategies, and plugins only know these types —
 * never Vapi, LiveKit, or Pipecat specifics.
 *
 * This is what makes the system orchestrator-agnostic.
 */

// Event type constants
const EVENT_TYPES = {
  CONVERSATION_STARTED: 'conversation.started',
  CONVERSATION_ENDED: 'conversation.ended',
  USER_TRANSCRIPT: 'user.transcript',
  USER_SPEECH_STARTED: 'user.speech_started',
  USER_SPEECH_ENDED: 'user.speech_ended',
  ASSISTANT_SPEAKING: 'assistant.speaking',
  TOOL_CALLED: 'tool.called',
  TOOL_RESULT: 'tool.result',
  OUTCOME_DERIVED: 'outcome.derived',
  ERROR: 'error',
};

/**
 * Create a domain event.
 * @param {string} type - One of EVENT_TYPES
 * @param {Object} payload - Event-specific data
 * @returns {Object} Domain event with type, payload, and timestamp
 */
function createEvent(type, payload = {}) {
  return {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { EVENT_TYPES, createEvent };
