'use strict';

/**
 * Conversation Strategy (interface)
 *
 * Each use case (medication adherence, emergency triage) implements this.
 * The conversation engine delegates all use-case-specific logic to the
 * active strategy — it never knows what use case it's running.
 *
 * This is what makes the system multi-use-case: add a new use case by
 * creating a new strategy implementation, without touching the engine.
 */
class ConversationStrategy {
  /** Unique name for this use case (e.g., "medication-adherence") */
  get name() {
    throw new Error('ConversationStrategy.name not implemented');
  }

  /**
   * Build the system prompt for this use case.
   * @param {Object} variables - Per-call variables (parent_name, drug_name, etc.)
   * @returns {string} System prompt
   */
  buildSystemPrompt(variables) {
    throw new Error('ConversationStrategy.buildSystemPrompt() not implemented');
  }

  /**
   * Build the first message for this use case.
   * @param {Object} variables - Per-call variables
   * @returns {string} First message
   */
  buildFirstMessage(variables) {
    throw new Error('ConversationStrategy.buildFirstMessage() not implemented');
  }

  /**
   * Get the function tools available for this use case.
   * @returns {Array} Tool definitions
   */
  getTools() {
    throw new Error('ConversationStrategy.getTools() not implemented');
  }

  /**
   * Derive the call outcome from call data.
   * @param {Object} callData - { toolCalls, transcript, analysis, endedReason }
   * @returns {Object} { label, source, reason }
   */
  deriveOutcome(callData) {
    throw new Error('ConversationStrategy.deriveOutcome() not implemented');
  }

  /**
   * Determine if this call should be escalated.
   * @param {Object} outcome - The derived outcome
   * @returns {boolean}
   */
  shouldEscalate(outcome) {
    throw new Error('ConversationStrategy.shouldEscalate() not implemented');
  }

  /**
   * Get use-case-specific config (timeouts, thresholds, etc.).
   * @returns {Object}
   */
  getConfig() {
    throw new Error('ConversationStrategy.getConfig() not implemented');
  }
}

module.exports = ConversationStrategy;
