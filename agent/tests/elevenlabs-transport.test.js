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
    assert.strictEqual(byName.report_outcome.execution_mode, 'immediate');
    assert.strictEqual(byName.capture_field.execution_mode, 'async');
  });

  test('every execution_mode is one the API actually accepts', () => {
    // 'sync' was invented in the plan and rejected by a live PATCH with a 400.
    const VALID = new Set(['immediate', 'post_tool_speech', 'async']);
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    for (const t of tools) {
      assert.ok(VALID.has(t.execution_mode), `${t.name} has invalid execution_mode ${t.execution_mode}`);
    }
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

  test('declares kinvox_call_id bound to the dynamic variable, on every tool', () => {
    // Without this, the webhook has no idea which call a tool call belongs
    // to — ElevenLabs' documented dynamic variables carry no conversation id.
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    for (const t of tools) {
      const prop = t.api_schema.request_body_schema.properties.kinvox_call_id;
      assert.strictEqual(prop.type, 'string');
      assert.strictEqual(prop.dynamic_variable, 'kinvox_call_id');
    }
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

    // kinvox_call_id rides alongside the caller's own variables — it isn't
    // one of them, so it's asserted separately below rather than folded
    // into one deepStrictEqual against the whole object.
    const dynamicVariables = cap.body.conversation_initiation_client_data.dynamic_variables;
    assert.strictEqual(dynamicVariables.patient_name, 'Kamala');
    assert.strictEqual(dynamicVariables.meal_slot, 'morning');
  });

  test('createCall mints a kinvox_call_id and puts it in dynamic_variables', async () => {
    // ElevenLabs' documented dynamic variables (system__call_duration_secs,
    // system__time) carry no conversation id, so the tool webhook has no
    // other way to know which call it belongs to without this.
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const cap = {};
    const restore = stubFetch(cap);
    try {
      const a = new ElevenLabsTransportAdapter({});
      a.phoneNumberId = PHONE_ID;
      await a.createCall('agent_x', '+919000000042', {});
    } finally { restore(); }

    const { kinvox_call_id: callId } = cap.body.conversation_initiation_client_data.dynamic_variables;
    assert.strictEqual(typeof callId, 'string');
    assert.match(callId, /^[0-9a-f-]{36}$/);
  });

  test('createCall returns the kinvox_call_id it sent, so a caller can correlate', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const cap = {};
    const restore = stubFetch(cap);
    let result;
    try {
      const a = new ElevenLabsTransportAdapter({});
      a.phoneNumberId = PHONE_ID;
      result = await a.createCall('agent_x', '+919000000042', {});
    } finally { restore(); }

    const sentId = cap.body.conversation_initiation_client_data.dynamic_variables.kinvox_call_id;
    assert.strictEqual(result.kinvox_call_id, sentId);
    // The API's own response fields (conversation_id, callSid) still pass through.
    assert.strictEqual(result.conversation_id, 'conv_1');
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

describe('boot-time agent patch', () => {
  test('pushes the current tunnel into the agent tool URLs', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.ELEVENLABS_AGENT_ID = 'agent_copy';
    const cap = {};
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      cap.url = url; cap.method = opts.method; cap.body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const a = new ElevenLabsTransportAdapter({});
      await a.start(null, { getEventBus: () => ({ emit() {} }) }, {
        webhookUrl: 'https://fresh-tunnel.ngrok-free.dev',
        strategy: {
          buildSystemPrompt: () => 'P', buildFirstMessage: () => 'F',
          getTools: () => require('../tools.json').tools,
        },
      });
    } finally { globalThis.fetch = real; }

    assert.strictEqual(cap.method, 'PATCH');
    assert.strictEqual(cap.url, 'https://api.elevenlabs.io/v1/convai/agents/agent_copy');
    const tools = cap.body.conversation_config.agent.prompt.tools;
    assert.ok(tools.every((t) => t.api_schema.url.startsWith('https://fresh-tunnel.ngrok-free.dev')));
  });

  test('does not patch, and does not throw, when no agent id is configured', async () => {
    delete process.env.ELEVENLABS_AGENT_ID;
    let called = false;
    const real = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    try {
      const a = new ElevenLabsTransportAdapter({});
      await a.start(null, { getEventBus: () => ({ emit() {} }) }, { webhookUrl: 'https://x', strategy: {} });
    } finally { globalThis.fetch = real; }
    assert.strictEqual(called, false);
  });

  test('a failed patch rejects with the status, so the caller can decide', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    const real = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'bad config' })
    try {
      const a = new ElevenLabsTransportAdapter({})
      await assert.rejects(() => a._patchAgent('agent_x', {}), /422/)
    } finally {
      globalThis.fetch = real
    }
  })
});
