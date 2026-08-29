'use strict';

const { EventBus, EVENT_TYPES } = require('./event-bus');

/**
 * Conversation Engine
 *
 * The orchestrator-agnostic core. It receives domain events from the
 * transport adapter, processes them through the active strategy and
 * plugins, and emits outcome events.
 *
 * The engine never imports Vapi, LiveKit, Sarvam, or any provider.
 * It only knows ports, strategies, and plugins.
 */
class ConversationEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.strategy - Active ConversationStrategy
   * @param {Object} deps.plugins - PluginRegistry instance
   * @param {Object} deps.repository - OutcomeRepositoryPort instance
   */
  constructor({ strategy, plugins, repository }) {
    this.strategy = strategy;
    this.plugins = plugins;
    this.repository = repository;
    this.eventBus = new EventBus();

    this._setupEventHandlers();
  }

  /**
   * Subscribe to domain events and wire them to strategy/plugins.
   * @private
   */
  _setupEventHandlers() {
    // Log every event (observability)
    this.eventBus.use((event) => {
      console.log(JSON.stringify({
        event: 'domain_event',
        type: event.type,
        timestamp: event.timestamp,
        ...event.payload,
      }));
    });

    // On conversation start — notify plugins
    this.eventBus.on(EVENT_TYPES.CONVERSATION_STARTED, async (event) => {
      await this.plugins.callHook('onConversationStart', event.payload);
    });

    // On user transcript — notify plugins (they can annotate/transform)
    this.eventBus.on(EVENT_TYPES.USER_TRANSCRIPT, async (event) => {
      await this.plugins.callHook('onTranscript', event, event.payload);
    });

    // On tool call — notify plugins
    this.eventBus.on(EVENT_TYPES.TOOL_CALLED, async (event) => {
      await this.plugins.callHook('onToolCall', event.payload);
    });

    // On conversation end — derive outcome, check escalation, persist
    this.eventBus.on(EVENT_TYPES.CONVERSATION_ENDED, async (event) => {
      const { callData } = event.payload;

      // Let plugins contribute to outcome derivation
      await this.plugins.callHook('onOutcomeDerive', callData);

      // Strategy derives the outcome
      const outcome = this.strategy.deriveOutcome(callData);

      // Emit outcome event
      await this.eventBus.emit(EVENT_TYPES.OUTCOME_DERIVED, { outcome, callData });

      // Persist BEFORE acting on the escalation.
      // The alert plugin stamps alert_sent_at via an UPDATE, so the row has to
      // exist first — otherwise the stamp lands on zero rows and escalation
      // latency is silently unrecordable.
      if (this.repository) {
        await this.repository.save({
          ...outcome,
          callId: callData.callId,
          transcript: callData.transcript,
          duration: callData.duration,
          cost: callData.cost,
          // Which prompt produced this outcome. Without it, a mid-pilot prompt
          // change makes every prior call unattributable.
          promptVersion: typeof this.strategy.getPromptVersion === 'function'
            ? String(this.strategy.getPromptVersion())
            : null,
          parentId: callData.parentId || callData.variables?.parent_id || null,
          attemptNumber: callData.attemptNumber ?? null,
        });
      }

      // Check if escalation is needed
      if (this.strategy.shouldEscalate(outcome)) {
        await this.plugins.callHook('onEscalation', outcome, callData);
      }

      // Notify plugins of conversation end
      await this.plugins.callHook('onConversationEnd', callData);
    });
  }

  /**
   * Get the event bus (for transport adapters to emit events).
   * @returns {EventBus}
   */
  getEventBus() {
    return this.eventBus;
  }

  /**
   * Get the active strategy.
   * @returns {ConversationStrategy}
   */
  getStrategy() {
    return this.strategy;
  }

  /**
   * Get all tools (strategy tools + plugin tools).
   * @returns {Array}
   */
  getAllTools() {
    return [...this.strategy.getTools(), ...this.plugins.getAllTools()];
  }
}

module.exports = ConversationEngine;
