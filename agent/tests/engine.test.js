'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { EventBus, EVENT_TYPES } = require('../src/core/engine/event-bus');
const { createEvent } = require('../src/core/events/types');

describe('EventBus', () => {
  test('emit calls subscribed handlers', async () => {
    const bus = new EventBus();
    let received = null;
    bus.on(EVENT_TYPES.CONVERSATION_STARTED, (event) => {
      received = event;
    });
    await bus.emit(EVENT_TYPES.CONVERSATION_STARTED, { callId: 'test-123' });
    assert.strictEqual(received.payload.callId, 'test-123');
    assert.strictEqual(received.type, 'conversation.started');
    assert.ok(received.timestamp);
  });

  test('emit calls multiple handlers in order', async () => {
    const bus = new EventBus();
    const calls = [];
    bus.on(EVENT_TYPES.TOOL_CALLED, () => calls.push(1));
    bus.on(EVENT_TYPES.TOOL_CALLED, () => calls.push(2));
    bus.on(EVENT_TYPES.TOOL_CALLED, () => calls.push(3));
    await bus.emit(EVENT_TYPES.TOOL_CALLED, {});
    assert.deepStrictEqual(calls, [1, 2, 3]);
  });

  test('handler errors do not stop propagation', async () => {
    const bus = new EventBus();
    let secondCalled = false;
    bus.on(EVENT_TYPES.ERROR, () => { throw new Error('boom'); });
    bus.on(EVENT_TYPES.ERROR, () => { secondCalled = true; });
    await bus.emit(EVENT_TYPES.ERROR, {});
    assert.ok(secondCalled, 'second handler should still run');
  });

  test('middleware runs before handlers', async () => {
    const bus = new EventBus();
    const order = [];
    bus.use((event) => { order.push('middleware'); });
    bus.on(EVENT_TYPES.USER_TRANSCRIPT, () => { order.push('handler'); });
    await bus.emit(EVENT_TYPES.USER_TRANSCRIPT, {});
    assert.deepStrictEqual(order, ['middleware', 'handler']);
  });

  test('middleware errors do not stop event propagation', async () => {
    const bus = new EventBus();
    let handlerCalled = false;
    bus.use(() => { throw new Error('middleware boom'); });
    bus.on(EVENT_TYPES.OUTCOME_DERIVED, () => { handlerCalled = true; });
    await bus.emit(EVENT_TYPES.OUTCOME_DERIVED, {});
    assert.ok(handlerCalled);
  });

  test('emit with no subscribers does nothing', async () => {
    const bus = new EventBus();
    await bus.emit(EVENT_TYPES.CONVERSATION_ENDED, { callId: 'x' });
    // No assertion needed — just should not throw
  });
});

describe('createEvent', () => {
  test('creates event with type, payload, and timestamp', () => {
    const event = createEvent('test.event', { foo: 'bar' });
    assert.strictEqual(event.type, 'test.event');
    assert.strictEqual(event.payload.foo, 'bar');
    assert.ok(event.timestamp);
  });

  test('defaults payload to empty object', () => {
    const event = createEvent('test.event');
    assert.deepStrictEqual(event.payload, {});
  });
});

describe('EVENT_TYPES', () => {
  test('has all expected event types', () => {
    const expected = [
      'CONVERSATION_STARTED', 'CONVERSATION_ENDED',
      'USER_TRANSCRIPT', 'USER_SPEECH_STARTED', 'USER_SPEECH_ENDED',
      'ASSISTANT_SPEAKING', 'TOOL_CALLED', 'TOOL_RESULT',
      'OUTCOME_DERIVED', 'ERROR',
    ];
    for (const key of expected) {
      assert.ok(EVENT_TYPES[key], `missing EVENT_TYPES.${key}`);
    }
  });

  test('event type values are dotted strings', () => {
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      // ERROR is 'error' — a single word, not dotted. All others are dotted.
      if (key === 'ERROR') continue;
      assert.ok(value.includes('.'), `${key}="${value}" should be a dotted string`);
    }
  });
});
