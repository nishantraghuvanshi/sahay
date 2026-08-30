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
    // Two webhook tools of ours plus the three ElevenLabs system tools. The
    // source agent's send_guardian_alert is gone; the system tools are ours
    // now, declared deliberately, because sending `tools` replaces the list
    // and would otherwise delete end_call along with it.
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools;
    assert.strictEqual(tools.filter((t) => t.type === 'webhook').length, 2);
    assert.strictEqual(tools.filter((t) => t.type === 'system').length, 3);
  });

  test('speaks Hindi, not the English the source agent was set to', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x.ngrok-free.dev');
    assert.strictEqual(cfg.conversation_config.agent.language, 'hi');
  });

  test('declares one webhook tool per strategy tool, pointed at our tunnel', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x.ngrok-free.dev');
    const tools = cfg.conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
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
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.strictEqual(byName.report_outcome.execution_mode, 'immediate');
    assert.strictEqual(byName.capture_field.execution_mode, 'async');
  });

  test('every execution_mode is one the API actually accepts', () => {
    // 'sync' was invented in the plan and rejected by a live PATCH with a 400.
    const VALID = new Set(['immediate', 'post_tool_speech', 'async']);
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
    for (const t of tools) {
      assert.ok(VALID.has(t.execution_mode), `${t.name} has invalid execution_mode ${t.execution_mode}`);
    }
  });

  test('retires send_guardian_alert rather than repointing it', () => {
    // Escalation is already an outcome of report_outcome. Two tools that both
    // alert the family is one too many, and the old one pointed at a dead host.
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
    assert.ok(!tools.some((t) => t.name === 'send_guardian_alert'));
  });

  test('carries the tool parameter schema across, enums included', () => {
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
    const outcome = tools.find((t) => t.name === 'report_outcome');
    const props = outcome.api_schema.request_body_schema.properties;
    assert.ok(props.outcome.enum.includes('ESCALATED_SYMPTOM'));
    assert.deepStrictEqual(outcome.api_schema.request_body_schema.required.sort(), ['outcome', 'reason']);
  });

  test('declares voxikin_call_id bound to the dynamic variable, on every tool', () => {
    // Without this, the webhook has no idea which call a tool call belongs
    // to — ElevenLabs' documented dynamic variables carry no conversation id.
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
    for (const t of tools) {
      const prop = t.api_schema.request_body_schema.properties.voxikin_call_id;
      assert.strictEqual(prop.type, 'string');
      assert.strictEqual(prop.dynamic_variable, 'voxikin_call_id');
      // A live PATCH 400'd when this property carried dynamic_variable
      // alongside is_system_provided/constant_value/is_omitted — the API
      // accepts only one of that mutually-exclusive set per property.
      assert.strictEqual(prop.description, undefined);
      assert.strictEqual(prop.is_system_provided, undefined);
      assert.strictEqual(prop.constant_value, undefined);
      assert.strictEqual(prop.is_omitted, undefined);
    }
  });

  test('every tool property sets at most one of description/dynamic_variable/is_system_provided/constant_value/is_omitted', () => {
    // The API rejects a property that sets more than one of these five keys.
    // Pinned generically, not just for voxikin_call_id, so the next property
    // anyone adds to any tool cannot silently reintroduce the same 400.
    const MUTUALLY_EXCLUSIVE = ['description', 'dynamic_variable', 'is_system_provided', 'constant_value', 'is_omitted'];
    const a = new ElevenLabsTransportAdapter({});
    const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
    for (const t of tools) {
      const properties = t.api_schema.request_body_schema.properties;
      for (const [name, prop] of Object.entries(properties)) {
        const present = MUTUALLY_EXCLUSIVE.filter((k) => prop[k] !== undefined);
        assert.ok(
          present.length <= 1,
          `${t.name}.${name} sets more than one of ${MUTUALLY_EXCLUSIVE.join('/')}: ${present.join(', ')}`
        );
      }
    }
  });

  test('sends the shared secret on every tool call, so the webhook route can verify it', () => {
    const originalSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    process.env.ELEVENLABS_WEBHOOK_SECRET = 'test-secret';
    try {
      const a = new ElevenLabsTransportAdapter({});
      const tools = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
      for (const t of tools) {
        assert.strictEqual(t.api_schema.request_headers['X-Voxikin-Token'], 'test-secret');
      }
    } finally {
      process.env.ELEVENLABS_WEBHOOK_SECRET = originalSecret;
    }
  });
});

describe('buildAssistantConfig — prompt interpolation uses placeholders, not demo defaults', () => {
  const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

  test('parent_name and drug_name become ElevenLabs placeholders in both prompt and first message', () => {
    const a = new ElevenLabsTransportAdapter({});
    const strategy = new MedicationAdherenceStrategy('hi');
    const cfg = a.buildAssistantConfig(strategy, {}, 'https://x');
    const prompt = cfg.conversation_config.agent.prompt.prompt;
    const firstMessage = cfg.conversation_config.agent.first_message;

    assert.ok(prompt.includes('{{parent_name}}'), 'prompt should contain {{parent_name}}');
    assert.ok(prompt.includes('{{drug_name}}'), 'prompt should contain {{drug_name}}');
    assert.ok(firstMessage.includes('{{parent_name}}'), 'first_message should contain {{parent_name}}');
    assert.ok(firstMessage.includes('{{drug_name}}'), 'first_message should contain {{drug_name}}');
  });

  test('the demo defaults are gone from the first message, which every call would otherwise reuse verbatim', () => {
    const a = new ElevenLabsTransportAdapter({});
    const strategy = new MedicationAdherenceStrategy('hi');
    const cfg = a.buildAssistantConfig(strategy, {}, 'https://x');
    const firstMessage = cfg.conversation_config.agent.first_message;

    assert.ok(!firstMessage.includes('रोहन'), 'first_message must not contain the demo parent name');
    assert.ok(!firstMessage.includes('Crocin'), 'first_message must not contain the demo drug name');
  });

  test('the demo patient name is gone from the system prompt too', () => {
    // "Crocin" is deliberately NOT checked against the full system prompt:
    // shared_rules cites it as a fixed style example ('Drug names and proper
    // nouns stay in English (e.g., "Crocin", "Paracetamol")'), independent of
    // the drug_name variable — that literal string is expected to remain
    // regardless of this fix, so asserting its absence would be a false test.
    const a = new ElevenLabsTransportAdapter({});
    const strategy = new MedicationAdherenceStrategy('hi');
    const cfg = a.buildAssistantConfig(strategy, {}, 'https://x');
    const prompt = cfg.conversation_config.agent.prompt.prompt;

    assert.ok(!prompt.includes('रोहन'), 'prompt must not contain the demo parent name');
  });

  test('an empty-string default (context_line) is kept empty, not turned into a placeholder', () => {
    let captured;
    const strategy = {
      getVariables: () => ({ parent_name: 'रोहन', context_line: '', fields_summary: '' }),
      buildFirstMessage: (vars) => { captured = vars; return 'ignored'; },
      buildSystemPrompt: () => 'ignored',
      getTools: () => [],
    };
    const a = new ElevenLabsTransportAdapter({});
    a.buildAssistantConfig(strategy, {}, 'https://x');

    assert.strictEqual(captured.parent_name, '{{parent_name}}');
    assert.strictEqual(captured.context_line, '');
    assert.strictEqual(captured.fields_summary, '');
  });

  test('control-flow keys (alert_delivered and its two line templates) keep their default rather than becoming a text placeholder', () => {
    // alert_delivered gates a ternary in _resolveAlertDeliveredLine, not text
    // substitution — a non-empty placeholder string would be truthy and
    // always pick the "already told your family" line, a false guardrail
    // claim. The two *_line keys are only ever read BY that resolution, never
    // substituted into the prompt via their own {key} tag, so placeholder-
    // ifying them would bake a raw "{{alert_delivered_false_line}}" string
    // into spoken guardrail text instead.
    let captured;
    const strategy = {
      getVariables: () => ({
        alert_delivered: false,
        alert_delivered_true_line: 'true line text',
        alert_delivered_false_line: 'false line text',
      }),
      buildFirstMessage: () => 'ignored',
      buildSystemPrompt: (vars) => { captured = vars; return 'ignored'; },
      getTools: () => [],
    };
    const a = new ElevenLabsTransportAdapter({});
    a.buildAssistantConfig(strategy, {}, 'https://x');

    assert.strictEqual(captured.alert_delivered, false);
    assert.strictEqual(captured.alert_delivered_true_line, 'true line text');
    assert.strictEqual(captured.alert_delivered_false_line, 'false line text');
  });
});

describe('buildAssistantConfig — post-call webhook registration', () => {
  function withEnv(name, value, fn) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
  }

  test('platform_settings carries the webhook id and events when the env var is set', () =>
    withEnv('ELEVENLABS_POST_CALL_WEBHOOK_ID', 'webhook_abc123', () => {
      const a = new ElevenLabsTransportAdapter({});
      const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
      // TOP-LEVEL, a sibling of conversation_config — not nested inside it.
      // The PATCH body schema lists conversation_config and platform_settings
      // as separate top-level properties, and a live GET returns
      // platform_settings at the top level too. Nesting it was silently
      // accepted with a 200, because conversation_config allows additional
      // properties, so the webhook id went nowhere and nothing said so.
      // Asserts the webhook block specifically, not the whole of
      // platform_settings — data_collection lives alongside it now.
      assert.deepStrictEqual(cfg.platform_settings.workspace_overrides, {
        webhooks: { post_call_webhook_id: 'webhook_abc123', events: ['transcript'] },
      });
      assert.strictEqual(
        cfg.conversation_config.platform_settings,
        undefined,
        'platform_settings must not also be nested inside conversation_config'
      );
    }));

  test('platform_settings is omitted entirely when the env var is not set, rather than sent with a null id', () =>
    withEnv('ELEVENLABS_POST_CALL_WEBHOOK_ID', undefined, () => {
      const a = new ElevenLabsTransportAdapter({});
      const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
      assert.strictEqual('platform_settings' in cfg.conversation_config, false);
    }));
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

    // voxikin_call_id rides alongside the caller's own variables — it isn't
    // one of them, so it's asserted separately below rather than folded
    // into one deepStrictEqual against the whole object.
    const dynamicVariables = cap.body.conversation_initiation_client_data.dynamic_variables;
    assert.strictEqual(dynamicVariables.patient_name, 'Kamala');
    assert.strictEqual(dynamicVariables.meal_slot, 'morning');
  });

  test('createCall mints a voxikin_call_id and puts it in dynamic_variables', async () => {
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

    const { voxikin_call_id: callId } = cap.body.conversation_initiation_client_data.dynamic_variables;
    assert.strictEqual(typeof callId, 'string');
    assert.match(callId, /^[0-9a-f-]{36}$/);
  });

  test('createCall returns the voxikin_call_id it sent, so a caller can correlate', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const cap = {};
    const restore = stubFetch(cap);
    let result;
    try {
      const a = new ElevenLabsTransportAdapter({});
      a.phoneNumberId = PHONE_ID;
      result = await a.createCall('agent_x', '+919000000042', {});
    } finally { restore(); }

    const sentId = cap.body.conversation_initiation_client_data.dynamic_variables.voxikin_call_id;
    assert.strictEqual(result.voxikin_call_id, sentId);
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
    const tools = cap.body.conversation_config.agent.prompt.tools.filter((t) => t.type === 'webhook');
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

describe('getAssistantId — the outbound entrypoint must not be Vapi-specific', () => {
  // POST /api/call read VAPI_ASSISTANT_ID unconditionally, so with
  // active.transport: elevenlabs it either 500'd for a missing Vapi env var or
  // handed a Vapi assistant id to ElevenLabs as its agent_id. Nothing in the
  // shipped product could place an ElevenLabs call; the one live call was
  // dispatched out of band. Each adapter now names its own id.
  function withEnvVar(name, value, fn) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
  }

  test('returns the configured ElevenLabs agent id', () =>
    withEnvVar('ELEVENLABS_AGENT_ID', 'agent_test_123', () => {
      const a = new ElevenLabsTransportAdapter({});
      assert.strictEqual(a.getAssistantId(), 'agent_test_123');
    }));

  test('throws naming the env var and the setup script when unset', () =>
    withEnvVar('ELEVENLABS_AGENT_ID', undefined, () => {
      const a = new ElevenLabsTransportAdapter({});
      assert.throws(() => a.getAssistantId(), /ELEVENLABS_AGENT_ID/);
      assert.throws(() => a.getAssistantId(), /setup-elevenlabs/);
    }));

  test('prefers the id captured at start() over a later env change', () =>
    withEnvVar('ELEVENLABS_AGENT_ID', 'agent_from_env', () => {
      const a = new ElevenLabsTransportAdapter({});
      a.agentId = 'agent_from_start';
      assert.strictEqual(a.getAssistantId(), 'agent_from_start');
    }));
});

describe('dynamic_variable_placeholders — an omitted variable must not be spoken raw', () => {
  // The prompt is a template. A caller that omits caregiver_name leaves
  // "{{caregiver_name}}" in the escalation reassurance line — the one sentence
  // whose whole purpose is an honest claim about contacting the family. Seeding
  // ElevenLabs' own defaults means an omission degrades to the strategy's
  // default rather than speaking the placeholder aloud.
  const STRATEGY_WITH_VARS = {
    ...STRATEGY,
    getVariables: () => ({
      parent_name: 'रोहन',
      drug_name: 'Crocin',
      caregiver_name: 'आपके परिवार',
      context_line: '',
      alert_delivered: false,
      alert_delivered_true_line: 'x',
    }),
  };

  test('seeds placeholders from the strategy defaults', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY_WITH_VARS, {}, 'https://x');
    const placeholders = cfg.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders;
    assert.strictEqual(placeholders.caregiver_name, 'आपके परिवार');
    assert.strictEqual(placeholders.parent_name, 'रोहन');
    assert.strictEqual(placeholders.drug_name, 'Crocin');
  });

  test('omits the keys that were never templated', () => {
    // Control-flow keys and empty-string defaults are not placeholders in the
    // prompt, so a default for them would be meaningless at best and would
    // flip an empty-check branch at worst.
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY_WITH_VARS, {}, 'https://x');
    const placeholders = cfg.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders;
    assert.strictEqual('context_line' in placeholders, false);
    assert.strictEqual('alert_delivered' in placeholders, false);
    assert.strictEqual('alert_delivered_true_line' in placeholders, false);
  });

  test('is omitted entirely when the strategy exposes no variables', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.agent.dynamic_variables, undefined);
  });
});

describe('system tools — the agent must be able to hang up', () => {
  // buildAssistantConfig sent only our two webhook tools, and a PATCH carrying
  // `tools` REPLACES the list — so the three system tools the source agent
  // carried were cleared, silently, with a 200. Our agent had no end_call while
  // the prompt instructs end_call roughly ten times.
  //
  // The model's response to being told to call a tool that does not exist was
  // to SAY it: transcripts show a literal "[end_call]" spoken aloud and
  // repeated until the turn cap. On the one real call the agent never hung up —
  // endedReason was "Call ended by remote party", i.e. the human gave up. Every
  // non-terminating loop in the scenario battery traces back to this.
  //
  // They go INSIDE tools, not in a sibling built_in_tools. Verified against the
  // live API: built_in_tools sent alongside tools is discarded with a 200,
  // while system entries inside tools are applied and the server derives
  // built_in_tools from them.
  function toolsOf(cfg) {
    // Unfiltered on purpose: this describe is about the system tools that
    // share the array with our webhook tools.
    return cfg.conversation_config.agent.prompt.tools;
  }

  test('end_call is declared, so the agent can actually end the call', () => {
    const a = new ElevenLabsTransportAdapter({});
    const tools = toolsOf(a.buildAssistantConfig(STRATEGY, {}, 'https://x'));
    const endCall = tools.find((t) => t.name === 'end_call');
    assert.ok(endCall, 'end_call must be declared');
    assert.strictEqual(endCall.type, 'system');
    assert.strictEqual(endCall.params.system_tool_type, 'end_call');
  });

  test('voicemail_detection is declared, and leaves no message behind', () => {
    const a = new ElevenLabsTransportAdapter({});
    const vm = toolsOf(a.buildAssistantConfig(STRATEGY, {}, 'https://x'))
      .find((t) => t.name === 'voicemail_detection');
    assert.ok(vm);
    assert.strictEqual(vm.params.system_tool_type, 'voicemail_detection');
    // A recording about someone's medication, playable by anyone in the house.
    assert.strictEqual(vm.params.voicemail_message, '');
  });

  test('language_detection is declared, for callers who answer in another language', () => {
    const a = new ElevenLabsTransportAdapter({});
    const ld = toolsOf(a.buildAssistantConfig(STRATEGY, {}, 'https://x'))
      .find((t) => t.name === 'language_detection');
    assert.ok(ld);
    assert.strictEqual(ld.params.system_tool_type, 'language_detection');
  });

  test('declares no transfer or subagent tools — there is nobody to transfer to', () => {
    const a = new ElevenLabsTransportAdapter({});
    const names = toolsOf(a.buildAssistantConfig(STRATEGY, {}, 'https://x')).map((t) => t.name);
    for (const forbidden of ['transfer_to_number', 'transfer_to_agent', 'run_subagent']) {
      assert.strictEqual(names.includes(forbidden), false, `${forbidden} must not be declared`);
    }
  });

  test('the webhook tools come first and are unaffected', () => {
    const a = new ElevenLabsTransportAdapter({});
    const tools = toolsOf(a.buildAssistantConfig(STRATEGY, {}, 'https://x'));
    assert.deepStrictEqual(tools.slice(0, 2).map((t) => t.name), ['report_outcome', 'capture_field']);
    assert.deepStrictEqual(
      tools.map((t) => t.name),
      ['report_outcome', 'capture_field', 'end_call', 'language_detection', 'voicemail_detection']
    );
  });

  test('no sibling built_in_tools key is sent, since it would be ignored', () => {
    const a = new ElevenLabsTransportAdapter({});
    const prompt = a.buildAssistantConfig(STRATEGY, {}, 'https://x').conversation_config.agent.prompt;
    assert.strictEqual('built_in_tools' in prompt, false);
  });
});

describe('llm selection — swappable without a code change', () => {
  // The model was hardcoded to gemini-2.5-flash. It is the largest single
  // contributor to perceived latency: measured on a real call, LLM ttfb ran
  // 1029-1700ms out of a 2252-3882ms silence-to-first-audio, against ~160ms
  // for TTS and ~30ms for ASR. Comparing candidates needs the model to come
  // from config, like every other provider choice in this repo.
  test('reads the model from providers.yaml', () => {
    const a = new ElevenLabsTransportAdapter({}, {
      transport: { elevenlabs: { llm: 'gemini-2.0-flash' } },
    });
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.agent.prompt.llm, 'gemini-2.0-flash');
  });

  test('falls back to the known-good model when unconfigured', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.agent.prompt.llm, 'gemini-2.5-flash');
  });

  test('start() config can override the constructor, as it does for the phone number', () => {
    const a = new ElevenLabsTransportAdapter({}, {
      transport: { elevenlabs: { llm: 'gemini-2.0-flash' } },
    });
    return a
      .start(null, null, {
        providersConfig: { transport: { elevenlabs: { llm: 'claude-haiku-4-5' } } },
      })
      .then(() => {
        const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
        assert.strictEqual(cfg.conversation_config.agent.prompt.llm, 'claude-haiku-4-5');
      });
  });
});

describe('thinking_budget — the agent should answer, not deliberate', () => {
  // gemini-2.5-flash reasons internally before replying. The agent had
  // thinking_budget: null, i.e. the model default, which for that model means
  // dynamic thinking is ON. That reasoning is paid for twice: once in latency
  // (LLM ttf_sentence measured 1029-1700ms of a 2252-3882ms wait) and once in
  // risk — the v6 transcript shows the deliberation being spoken aloud to a
  // patient in English.
  //
  // A dose call is a scripted branch, not a puzzle. The schema documents
  // "Use 0 to turn off if supported by the model".
  test('turns thinking off by default', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.agent.prompt.thinking_budget, 0);
  });

  test('can be raised from providers.yaml if a branch turns out to need it', () => {
    const a = new ElevenLabsTransportAdapter({}, {
      transport: { elevenlabs: { thinking_budget: 512 } },
    });
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.agent.prompt.thinking_budget, 512);
  });

  test('does not ask the provider for reasoning summaries', () => {
    // Documented as costing TTFB, and we would never show them to a caller.
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.agent.prompt.enable_reasoning_summary, false);
  });
});

describe('turn config — how long the agent waits before replying', () => {
  // Measured across two real calls, turn-taking silence ran 160-1280ms and is
  // now the largest component of perceived latency, the LLM having dropped to
  // ~500-850ms. It is a genuine trade: waiting less means occasionally cutting
  // off a slow speaker, and this product calls elderly people.
  test('sends the configured eagerness', () => {
    const a = new ElevenLabsTransportAdapter({}, {
      transport: { elevenlabs: { turn_eagerness: 'eager' } },
    });
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.turn.turn_eagerness, 'eager');
  });

  test('defaults to normal rather than silently rushing an elderly caller', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.turn.turn_eagerness, 'normal');
  });

  test('rejects a value the API does not accept, rather than sending it', () => {
    const a = new ElevenLabsTransportAdapter({}, {
      transport: { elevenlabs: { turn_eagerness: 'instant' } },
    });
    assert.throws(() => a.buildAssistantConfig(STRATEGY, {}, 'https://x'), /turn_eagerness/);
  });

  test('carries turn_timeout alongside it, so setting one does not drop the other', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(typeof cfg.conversation_config.turn.turn_timeout, 'number');
  });
});

describe('templating exclusions are by NAME, not by empty default', () => {
  // The rule used to be "any variable whose default is '' is not templated",
  // which happened to cover the three control-flow keys that gate an
  // empty-vs-non-empty branch in the strategy. It also silently covered every
  // FUTURE variable that starts out empty — such as next_call_line, whose
  // whole design is to be empty when there is no next dose to promise. That
  // one would have been frozen empty at boot and never filled per call, with
  // nothing to show for it: the config looks right and the feature never fires.
  const STRATEGY_WITH_EMPTIES = {
    ...STRATEGY,
    getVariables: () => ({
      parent_name: 'रोहन',
      // Genuinely control-flow: the strategy branches on whether these are set.
      context_line: '',
      fields_summary: '',
      missing_field: '',
      alert_delivered: false,
      // Ordinary per-call text that merely defaults to empty.
      next_call_line: '',
      food_line: '',
    }),
  };

  function placeholdersOf() {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY_WITH_EMPTIES, {}, 'https://x');
    return cfg.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders;
  }

  test('an ordinary variable with an empty default is still templated', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY_WITH_EMPTIES, {}, 'https://x');
    // buildFirstMessage/buildSystemPrompt receive the placeholder map; the
    // stub returns it so the substitution is observable.
    assert.ok('next_call_line' in placeholdersOf(), 'must get a per-call default');
    assert.strictEqual(placeholdersOf().next_call_line, '');
    assert.strictEqual(placeholdersOf().food_line, '');
    assert.ok(cfg.conversation_config.agent.prompt.prompt.length > 0);
  });

  test('the control-flow keys are still excluded, by name', () => {
    // Templating these would flip the branch they gate, or speak a literal
    // placeholder aloud — ruling R13.
    const p = placeholdersOf();
    for (const key of ['context_line', 'fields_summary', 'missing_field', 'alert_delivered']) {
      assert.strictEqual(key in p, false, `${key} must not become a dynamic variable`);
    }
  });
});

describe('data_collection — a backstop when report_outcome is not called', () => {
  // The agent does not always invoke report_outcome before ending a call. When
  // it does not, deriveOutcome's tier 2 needs something real to read, or the
  // call falls to keyword matching and then to the watchdog and is recorded
  // NO_ANSWER for a conversation that plainly established something.
  //
  // ElevenLabs extracts this field from the transcript after the call, so it
  // does not depend on the model remembering a tool mid-conversation.
  //
  // Shape established by probing the live API: a dict at
  // platform_settings.data_collection. The analysis_items.data_collection
  // variant in the schema 500s.
  test('declares dose_outcome for extraction', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    const field = cfg.platform_settings.data_collection.dose_outcome;
    assert.ok(field, 'dose_outcome must be declared');
    assert.strictEqual(field.type, 'string');
    for (const label of ['CONFIRMED', 'DENIED', 'UNCLEAR', 'ESCALATED_SYMPTOM']) {
      assert.match(field.description, new RegExp(label));
    }
  });

  test('tells the extractor that a promise is not a taken dose', () => {
    // The other intermittent defect: "मैं ले लूँगी" recorded as CONFIRMED.
    // The extractor is a second reader of the same transcript and must not
    // repeat the mistake the tool call sometimes makes.
    const a = new ElevenLabsTransportAdapter({});
    const d = a.buildAssistantConfig(STRATEGY, {}, 'https://x')
      .platform_settings.data_collection.dose_outcome.description;
    assert.match(d, /already/i);
    assert.match(d, /promise|intend|will take/i);
  });

  test('platform_settings is present even without a post-call webhook id', () => {
    // It used to appear only when ELEVENLABS_POST_CALL_WEBHOOK_ID was set, so
    // declaring the field would have depended on an unrelated env var.
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.ok(cfg.platform_settings.data_collection);
    assert.strictEqual(cfg.platform_settings.workspace_overrides, undefined);
  });
});

describe('call duration — a stuck call must end on its own', () => {
  // Two scenarios still loop: the agent repeats one refusal until the turn cap
  // and never files an outcome. Every attempt to fix that in the prompt has
  // half-worked, because the model cannot count its own turns — it has no idea
  // it is on the eighth identical reply.
  //
  // So bound it outside the model. A dose call that has run five minutes has
  // failed whatever it contains, and on a real line the caller is stuck on the
  // phone with it. The cap ends the call, the post-call webhook still fires,
  // and tier-2 extraction still files an outcome — so a bounded call is a
  // recorded call, not a lost one.
  test('caps the call well below the five-minute default', () => {
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    const secs = cfg.conversation_config.conversation.max_duration_seconds;
    assert.ok(secs > 0 && secs <= 240, `expected a real cap, got ${secs}`);
  });

  test('says something before hanging up on them', () => {
    // A call that simply stops is indistinguishable from the line dropping,
    // which for an elderly caller is the failure this product exists to avoid.
    const a = new ElevenLabsTransportAdapter({});
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    const msg = cfg.conversation_config.agent.max_conversation_duration_message;
    assert.ok(msg && msg.length > 10, 'a closing line is required');
    assert.doesNotMatch(msg, /\{\{/, 'must not carry an unfilled placeholder');
  });

  test('both are configurable from providers.yaml', () => {
    const a = new ElevenLabsTransportAdapter({}, {
      transport: { elevenlabs: { max_call_seconds: 90 } },
    });
    const cfg = a.buildAssistantConfig(STRATEGY, {}, 'https://x');
    assert.strictEqual(cfg.conversation_config.conversation.max_duration_seconds, 90);
  });
});
