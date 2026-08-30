'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const ElevenLabsTransportAdapter = require('../src/adapters/transport/elevenlabs');
const TransportPort = require('../src/core/ports/transport');

describe('ElevenLabsTransportAdapter', () => {
  test('implements the whole TransportPort surface', () => {
    const a = new ElevenLabsTransportAdapter({});
    assert.ok(a instanceof TransportPort);
    for (const m of ['start', 'buildAssistantConfig', 'createCall']) {
      assert.strictEqual(typeof a[m], 'function', `${m} must be implemented`);
    }
  });

  test('is selectable from the transport registry', () => {
    const TRANSPORTS = require('../src/adapters/transport/registry').TRANSPORT_ADAPTERS;
    assert.ok(TRANSPORTS.elevenlabs, 'elevenlabs must be registered');
  });
});

const STRATEGY = {
  buildSystemPrompt: () => 'SYSTEM PROMPT WITH GUARDRAILS',
  buildFirstMessage: () => 'Hello {{patient_name}}',
  getTools: () => require('../tools.json').tools,
};

describe('buildAssistantConfig', () => {
  test('carries the strategy prompt rather than a hand-copied one', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x.ngrok-free.dev');
    assert.strictEqual(cfg.conversation_config.agent.prompt.prompt, 'SYSTEM PROMPT WITH GUARDRAILS');
    assert.strictEqual(cfg.conversation_config.agent.first_message, 'Hello {{patient_name}}');
  });

  test('the tool list replaces the source agent\'s, it does not merge with it', () => {
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    assert.strictEqual(tools.length, 2);
  });

  test('speaks Hindi, not the English the source agent was set to', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x.ngrok-free.dev');
    assert.strictEqual(cfg.conversation_config.agent.language, 'hi');
  });

  test('declares one webhook tool per strategy tool, pointed at our tunnel', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x.ngrok-free.dev');
    const tools = cfg.conversation_config.agent.prompt.tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['capture_field', 'report_outcome']);
    for (const t of tools) {
      assert.strictEqual(t.type, 'webhook');
      assert.strictEqual(t.api_schema.url, `https://x.ngrok-free.dev/el/tools/${t.name}`);
      assert.strictEqual(t.api_schema.method, 'POST');
    }
  });

  test('report_outcome blocks the agent; capture_field does not', () => {
    // tools.json marks report_outcome async:false — two of its outcomes alert
    // the family, so the write must land before the agent moves on.
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.strictEqual(byName.report_outcome.execution_mode, 'sync');
    assert.strictEqual(byName.capture_field.execution_mode, 'async');
  });

  test('retires send_guardian_alert rather than repointing it', () => {
    // Escalation is already an outcome of report_outcome. Two tools that both
    // alert the family is one too many, and the old one pointed at a dead host.
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    assert.ok(!tools.some((t) => t.name === 'send_guardian_alert'));
  });

  test('carries the tool parameter schema across, enums included', () => {
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    const outcome = tools.find((t) => t.name === 'report_outcome');
    const props = outcome.api_schema.request_body_schema.properties;
    assert.ok(props.outcome.enum.includes('ESCALATED_SYMPTOM'));
    assert.deepStrictEqual(outcome.api_schema.request_body_schema.required.sort(), ['outcome', 'reason']);
  });

  test('sends the shared secret on every tool call, so the webhook route can verify it', () => {
    const originalSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'test-secret';
    try {
      const a = new ElevenLabsTransportAdapter({});
      const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
      for (const t of tools) {
        assert.strictEqual(t.api_schema.request_headers['X-Kinvox-Token'], 'test-secret');
      }
    } finally {
      process.env.ELEVENLABS_WEBHOOK_SECRET = originalSecret;
    }
  });
});

describe('createCall', () => {
  const PHONE_ID = 'phnum_2001m0m0dch2fvhv1jar36bfzd5p';

  function stubFetch(capture) {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capture.url = url;
      capture.body = JSON.parse(opts.body);
      capture.headers = opts.headers;
      return { ok: true, status: 200, json: async () => ({ conversation_id: 'conv_1', callSid: 'CA1' }) };
    };
    return () => { globalThis.fetch = real; };
  }

  test('posts the documented required fields', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const cap = {};
    const restore = stubFetch(cap);
    try {
      const a = new ElevenLabsTransportAdapter({});
      a.phoneNumberId = PHONE_ID;
      await a.createCall('agent_x', '+919000000042', { patient_name: 'Kamala' });
    } finally { restore(); }

    assert.strictEqual(cap.url, 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
    assert.strictEqual(cap.body.agent_id, 'agent_x');
    assert.strictEqual(cap.body.agent_phone_number_id, PHONE_ID);
    assert.strictEqual(cap.body.to_number, '+919000000042');
    assert.strictEqual(cap.headers['xi-api-key'], 'test-key');
  });

  test('per-call variables go in dynamic_variables, where the prompt reads them', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const cap = {};
    const restore = stubFetch(cap);
    try {
      const a = new ElevenLabsTransportAdapter({});
      a.phoneNumberId = PHONE_ID;
      await a.createCall('agent_x', '+919000000042', { patient_name: 'Kamala', meal_slot: 'morning' });
    } finally { restore(); }

    assert.deepStrictEqual(
      cap.body.conversation_initiation_client_data.dynamic_variables,
      { patient_name: 'Kamala', meal_slot: 'morning' }
    );
  });

  test('a missing phone number id is named, not left as a 422 from the API', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const a = new ElevenLabsTransportAdapter({});
    a.phoneNumberId = null;
    await assert.rejects(
      () => a.createCall('agent_x', '+919000000042', {}),
      /phone_number_id/
    );
  });
});
