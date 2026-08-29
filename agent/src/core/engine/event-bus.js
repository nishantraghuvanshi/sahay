'use strict';

const { EVENT_TYPES, createEvent } = require('../events/types');

/**
 * Internal Event Bus
 *
 * Simple pub/sub for domain events. Components subscribe to event types
 * and receive events when they're emitted.
 *
 * This enables:
 * - Observability (log every event)
 * - Extensibility (plugins subscribe to events)
 * - Testing (inject fake events, assert on output events)
 */
class EventBus {
  constructor() {
    this.handlers = new Map();
    this.middleware = [];
  }

  /**
   * Subscribe to an event type.
   * @param {string} eventType - One of EVENT_TYPES
   * @param {Function} handler - (event) => void | Promise<void>
   */
  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} eventType - One of EVENT_TYPES
   * @param {Object} payload - Event data
   */
  async emit(eventType, payload = {}) {
    const event = createEvent(eventType, payload);

    // Run middleware (logging, tracing, etc.)
    for (const mw of this.middleware) {
      try {
        await mw(event);
      } catch (e) {
        // Middleware errors don't stop event propagation
        console.error(JSON.stringify({
          event: 'event_bus_middleware_error',
          error: e.message,
          original_event: eventType,
        }));
      }
    }

    // Dispatch to subscribers
    const handlers = this.handlers.get(eventType) || [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (e) {
        console.error(JSON.stringify({
          event: 'event_bus_handler_error',
          error: e.message,
          event_type: eventType,
        }));
      }
    }
  }

  /**
   * Add middleware that runs on every event (for logging, tracing).
   * @param {Function} middleware - (event) => void | Promise<void>
   */
  use(middleware) {
    this.middleware.push(middleware);
  }
}

module.exports = { EventBus, EVENT_TYPES };
