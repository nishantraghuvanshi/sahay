'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ConversationEngine = require('../src/core/engine/engine');
const PluginRegistry = require('../src/core/plugins/registry');
const { EVENT_TYPES } = require('../src/core/events/types');

// --- Test doubles ---

class MockStrategy {
  get name() { return 'mock-use-case'; }
  buildSystemPrompt() { return 'test prompt'; }
  buildFirstMessage() { return 'test message'; }
  getTools() { return [{ type: 'function', function: { name: 'mock_tool' } }]; }
  deriveOutcome(callData) {
    return { label: callData.toolCalls?.[0]?.arguments?.outcome || 'NO_ANSWER', source: 'tool_call', reason: 'test' };
  }
  shouldEscalate(outcome) { return outcome.label === 'ESCALATED'; }
  getConfig() { return { version: 1 }; }
  getPromptVersion() { return 1; }
}

class MockRepository {
  constructor() { this.saved = []; }
  async save(outcome) { this.saved.push(outcome); }
  async list() { return this.saved; }
}

class MockPlugin {
  constructor() {
    this.name = 'mock-plugin';
    this.tools = [{ type: 'function', function: { name: 'plugin_tool' } }];
    this.hooksCalled = [];
  }
  async onConversationStart(ctx) { this.hooksCalled.push('onConversationStart'); }
  async onTranscript(event, ctx) { this.hooksCalled.push('onTranscript'); }
  async onToolCall(ctx) { this.hooksCalled.push('onToolCall'); }
  async onOutcomeDerive(ctx) { this.hooksCalled.push('onOutcomeDerive'); }
  async onEscalation(outcome, ctx) { this.hooksCalled.push('onEscalation'); }
  async onConversationEnd(ctx) { this.hooksCalled.push('onConversationEnd'); }
}

// --- Tests ---

describe('ConversationEngine', () => {
  test('constructor wires strategy, plugins, repository', () => {
    const engine = new ConversationEngine({
      strategy: new MockStrategy(),
      plugins: new PluginRegistry(),
      repository: new MockRepository(),
    });
    assert.ok(engine.eventBus);
    assert.ok(engine.strategy);
    assert.ok(engine.plugins);
    assert.ok(engine.repository);
  });

  test('getEventBus returns the EventBus instance', () => {
    const engine = new ConversationEngine({
      strategy: new MockStrategy(),
      plugins: new PluginRegistry(),
      repository: new MockRepository(),
    });
    assert.ok(engine.getEventBus());
    assert.strictEqual(typeof engine.getEventBus().emit, 'function');
  });

  test('getStrategy returns the active strategy', () => {
    const strategy = new MockStrategy();
    const engine = new ConversationEngine({
      strategy,
      plugins: new PluginRegistry(),
      repository: new MockRepository(),
    });
    assert.strictEqual(engine.getStrategy(), strategy);
  });

  test('getAllTools merges strategy tools and plugin tools', () => {
    const strategy = new MockStrategy();
    const plugins = new PluginRegistry();
    plugins.register(new MockPlugin());
    const engine = new ConversationEngine({
      strategy,
      plugins,
      repository: new MockRepository(),
    });
    const tools = engine.getAllTools();
    assert.strictEqual(tools.length, 2);
    assert.ok(tools.some(t => t.function.name === 'mock_tool'));
    assert.ok(tools.some(t => t.function.name === 'plugin_tool'));
  });

  test('CONVERSATION_STARTED triggers plugin onConversationStart', async () => {
    const plugin = new MockPlugin();
    const plugins = new PluginRegistry();
    plugins.register(plugin);
    const engine = new ConversationEngine({
      strategy: new MockStrategy(),
      plugins,
      repository: new MockRepository(),
    });
    await engine.getEventBus().emit(EVENT_TYPES.CONVERSATION_STARTED, { callId: 'c1' });
    assert.ok(plugin.hooksCalled.includes('onConversationStart'));
  });

  test('CONVERSATION_ENDED derives outcome, persists, and calls plugin hooks', async () => {
    const plugin = new MockPlugin();
    const plugins = new PluginRegistry();
    plugins.register(plugin);
    const repo = new MockRepository();
    const engine = new ConversationEngine({
      strategy: new MockStrategy(),
      plugins,
      repository: repo,
    });
    const callData = {
      callId: 'call-123',
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'CONFIRMED', reason: 'user said yes' } }],
      transcript: 'haan le liya',
      duration: 45,
      cost: 0.05,
    };
    await engine.getEventBus().emit(EVENT_TYPES.CONVERSATION_ENDED, { callData });

    assert.ok(plugin.hooksCalled.includes('onOutcomeDerive'));
    assert.ok(plugin.hooksCalled.includes('onConversationEnd'));
    assert.strictEqual(repo.saved.length, 1);
    assert.strictEqual(repo.saved[0].label, 'CONFIRMED');
    assert.strictEqual(repo.saved[0].callId, 'call-123');
  });

  test('CONVERSATION_ENDED triggers escalation hook for ESCALATED outcome', async () => {
    const plugin = new MockPlugin();
    const plugins = new PluginRegistry();
    plugins.register(plugin);
    const engine = new ConversationEngine({
      strategy: new MockStrategy(),
      plugins,
      repository: new MockRepository(),
    });
    const callData = {
      callId: 'call-esc',
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED', reason: 'symptom' } }],
      transcript: 'bukhar hai',
      duration: 30,
      cost: 0.03,
    };
    await engine.getEventBus().emit(EVENT_TYPES.CONVERSATION_ENDED, { callData });
    assert.ok(plugin.hooksCalled.includes('onEscalation'));
  });

  test('CONVERSATION_ENDED does not trigger escalation for CONFIRMED', async () => {
    const plugin = new MockPlugin();
    const plugins = new PluginRegistry();
    plugins.register(plugin);
    const engine = new ConversationEngine({
      strategy: new MockStrategy(),
      plugins,
      repository: new MockRepository(),
    });
    const callData = {
      callId: 'call-ok',
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'CONFIRMED', reason: 'ok' } }],
      transcript: 'haan',
      duration: 20,
      cost: 0.02,
    };
    await engine.getEventBus().emit(EVENT_TYPES.CONVERSATION_ENDED, { callData });
    assert.ok(!plugin.hooksCalled.includes('onEscalation'));
  });
});

describe('PluginRegistry', () => {
  test('register adds plugin to list', () => {
    const reg = new PluginRegistry();
    const plugin = { name: 'test-plugin' };
    reg.register(plugin);
    assert.strictEqual(reg.plugins.length, 1);
    assert.strictEqual(reg.plugins[0].name, 'test-plugin');
  });

  test('register throws if plugin has no name', () => {
    const reg = new PluginRegistry();
    assert.throws(() => reg.register({}), /name/);
  });

  test('getAllTools collects tools from all plugins', () => {
    const reg = new PluginRegistry();
    reg.register({ name: 'p1', tools: [{ function: { name: 't1' } }] });
    reg.register({ name: 'p2', tools: [{ function: { name: 't2' } }, { function: { name: 't3' } }] });
    reg.register({ name: 'p3' }); // no tools
    const tools = reg.getAllTools();
    assert.strictEqual(tools.length, 3);
  });

  test('callHook calls only plugins that implement the hook', async () => {
    const reg = new PluginRegistry();
    const called = [];
    reg.register({ name: 'p1', onConversationStart: () => called.push('p1') });
    reg.register({ name: 'p2' }); // no hook
    reg.register({ name: 'p3', onConversationStart: () => called.push('p3') });
    await reg.callHook('onConversationStart');
    assert.deepStrictEqual(called, ['p1', 'p3']);
  });

  test('callHook passes arguments through', async () => {
    const reg = new PluginRegistry();
    let received = null;
    reg.register({ name: 'p1', onTranscript: (event, ctx) => { received = { event, ctx }; } });
    const fakeEvent = { type: 'user.transcript', payload: { text: 'hello' } };
    await reg.callHook('onTranscript', fakeEvent, { callId: 'c1' });
    assert.strictEqual(received.event, fakeEvent);
    assert.strictEqual(received.ctx.callId, 'c1');
  });

  test('callHook does not throw when no plugin implements the hook', async () => {
    const reg = new PluginRegistry();
    reg.register({ name: 'p1' });
    await reg.callHook('onNonexistentHook');
    // should not throw
  });

  test('hook errors are caught and do not stop other plugins', async () => {
    const reg = new PluginRegistry();
    let secondCalled = false;
    reg.register({ name: 'p1', onConversationEnd: () => { throw new Error('plugin error'); } });
    reg.register({ name: 'p2', onConversationEnd: () => { secondCalled = true; } });
    await reg.callHook('onConversationEnd');
    assert.ok(secondCalled);
  });
});
