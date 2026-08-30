# ElevenLabs Outbound Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place the scheduled dose call through ElevenLabs Agents instead of Vapi, selected by one line in `config/providers.yaml`, with call outcomes landing in the same database.

**Architecture:** A new `ElevenLabsTransportAdapter` implements the existing `TransportPort` and registers alongside `vapi` and `playground`. ElevenLabs runs its own LLM (`gemini-2.5-flash`), so our `/llm/chat/completions` endpoint is unused — the engine is reached only through webhook tools. The Vapi path is not modified.

**Tech Stack:** Node 22 (CommonJS), `node:test`, `node:sqlite`, Express, ElevenLabs Agents REST API.

**Spec:** `docs/superpowers/specs/2026-08-30-elevenlabs-outbound-transport-design.md`

## Global Constraints

- **The 588-test baseline stays green.** Run `npm test` in `agent/` after every task. It is the safety net for touching a live calling path.
- **No network in unit tests.** Inject or stub `fetch`; the existing suite makes zero network calls.
- **Never mutate `agent_4901m0kzym5pfm7b7y9aprndv6qp`.** It is the prior product's agent. All patches target the duplicate whose id lives in `ELEVENLABS_AGENT_ID`.
- **Do not place a real phone call.** `simulate-conversation` is the integration test. A real call needs explicit human approval.
- **Prompts are generated from strategy files, never hand-copied.** `SETUP.md` records this going wrong once.
- Existing constants, verified live: agent to duplicate `agent_4901m0kzym5pfm7b7y9aprndv6qp`, phone number id `phnum_2001m0m0dch2fvhv1jar36bfzd5p`, voice `QTKSa2Iyv0yoxvXY2V8a`.
- API base `https://api.elevenlabs.io`, auth header `xi-api-key`.

## File Structure

| File | Responsibility |
|---|---|
| `src/adapters/transport/elevenlabs.js` (create) | The adapter: port methods, agent patching, tool declarations |
| `src/adapters/transport/registry.js` (modify) | Register `elevenlabs` |
| `config/providers.yaml` (modify) | `transport.elevenlabs` block |
| `src/server.js` (modify) | Load the repo-root `.env` as well as `agent/.env` |
| `scripts/setup-elevenlabs-agent.js` (create) | One-off: duplicate the agent, print the new id |
| `tests/elevenlabs-transport.test.js` (create) | Adapter unit tests |
| `tests/elevenlabs-tools.test.js` (create) | Tool webhook translation tests |

---

### Task 1: Load the repo-root `.env`

`ELEVENLABS_API_KEY` lives in the repo root `.env` alongside the other product credentials, but `dotenv.config()` reads only `agent/.env`, so the agent cannot see it. Load both, with `agent/.env` winning on conflict.

**Files:**
- Modify: `src/server.js:10`
- Test: `tests/env-loading.test.js` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `process.env.ELEVENLABS_API_KEY` available to all later tasks

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

describe('env loading', () => {
  test('the repo-root .env is loaded, not only agent/.env', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(
      src,
      /dotenv\.config\(\{\s*path:\s*path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'\.env'\)/,
      'server.js must load the repo-root .env so shared credentials reach the agent'
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/env-loading.test.js`
Expected: FAIL — the assertion does not match.

- [ ] **Step 3: Implement**

Replace line 10 of `src/server.js` (`dotenv.config();`) with:

```js
// Two files, deliberately. agent/.env holds what only the agent needs
// (WEBHOOK_URL, ports); the repo-root .env holds credentials shared with the
// Python Care API, so a key is configured once rather than copied. agent/.env
// is loaded first and dotenv does not overwrite, so the local file wins.
dotenv.config();
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
```

Add `const path = require('path');` near the other requires if absent.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd agent && node --test tests/env-loading.test.js`
Expected: PASS

- [ ] **Step 5: Confirm the key is visible**

Run: `cd agent && node -e "require('dotenv').config(); require('dotenv').config({path:'../.env'}); console.log('key present:', !!process.env.ELEVENLABS_API_KEY)"`
Expected: `key present: true`

- [ ] **Step 6: Full suite, then commit**

```bash
cd agent && npm test
git add agent/src/server.js agent/tests/env-loading.test.js
git commit -m "feat: load the repo-root .env so shared credentials reach the agent"
```

---

### Task 2: Duplicate the agent

A one-off setup script. Duplicating leaves the prior product's agent untouched and diffable.

**Files:**
- Create: `scripts/setup-elevenlabs-agent.js`

**Interfaces:**
- Consumes: `process.env.ELEVENLABS_API_KEY` (Task 1)
- Produces: an agent id the operator writes into `ELEVENLABS_AGENT_ID`

- [ ] **Step 1: Write the script**

```js
'use strict';
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const SOURCE_AGENT_ID = 'agent_4901m0kzym5pfm7b7y9aprndv6qp';
const API = 'https://api.elevenlabs.io';

/**
 * Duplicate the prior product's agent into one Kinvox owns.
 *
 * We never patch the original: it is English, carries its own 6,640-character
 * prompt, and works. Every later PATCH targets this copy, so the original stays
 * as a reference to diff against.
 */
async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Missing env var: ELEVENLABS_API_KEY');

  const res = await fetch(`${API}/v1/convai/agents/${SOURCE_AGENT_ID}/duplicate`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Kinvox Dose Call (outbound)' }),
  });
  if (!res.ok) {
    throw new Error(`duplicate failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  const id = body.agent_id;
  console.log(`\nDuplicated. Put this in your .env:\n\n  ELEVENLABS_AGENT_ID=${id}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `agent/package.json` `scripts`, add:

```json
"setup-elevenlabs": "node scripts/setup-elevenlabs-agent.js"
```

- [ ] **Step 3: Run it**

Run: `cd agent && npm run setup-elevenlabs`
Expected: prints `ELEVENLABS_AGENT_ID=agent_...`

- [ ] **Step 4: Record the id**

Add the printed line to `agent/.env`. Then confirm the original is untouched:

Run: `cd agent && node -e "require('dotenv').config();require('dotenv').config({path:'../.env'});fetch('https://api.elevenlabs.io/v1/convai/agents/agent_4901m0kzym5pfm7b7y9aprndv6qp',{headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY}}).then(r=>r.json()).then(a=>console.log('original language:', a.conversation_config.agent.language))"`
Expected: `original language: en` — unchanged.

- [ ] **Step 5: Commit**

```bash
git add agent/scripts/setup-elevenlabs-agent.js agent/package.json
git commit -m "feat: one-off script duplicating the ElevenLabs agent into a Kinvox copy"
```

---

### Task 3: Adapter skeleton, registry entry, config block

Make `active.transport: elevenlabs` selectable and port-compliant before any behaviour exists.

**Files:**
- Create: `src/adapters/transport/elevenlabs.js`
- Modify: `src/adapters/transport/registry.js:22-25`
- Modify: `config/providers.yaml:39-43`
- Test: `tests/elevenlabs-transport.test.js` (create)

**Interfaces:**
- Consumes: `TransportPort` from `src/core/ports/transport.js`
- Produces: `class ElevenLabsTransportAdapter extends TransportPort`, constructed as `new ElevenLabsTransportAdapter(providerRegistry)`, exported as the module's default export

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: FAIL — `Cannot find module '../src/adapters/transport/elevenlabs'`

- [ ] **Step 3: Create the adapter**

```js
'use strict';

const TransportPort = require('../../core/ports/transport');
const logger = require('../../utils/logger');

const API = 'https://api.elevenlabs.io';

/**
 * ElevenLabs Agents as a call orchestrator.
 *
 * Unlike the Vapi adapter, the LLM is NOT ours: ElevenLabs runs its own model,
 * so /llm/chat/completions is never called on this path. The engine is reached
 * only through webhook tools. That is the deliberate trade — see
 * docs/superpowers/specs/2026-08-30-elevenlabs-outbound-transport-design.md.
 *
 * Outbound only. Inbound calls are not handled: while this transport is active
 * the number still rings, but nothing here answers it.
 */
class ElevenLabsTransportAdapter extends TransportPort {
  constructor(providerRegistry) {
    super();
    this.providerRegistry = providerRegistry;
    this.engine = null;
    this.webhookUrl = null;
    this.agentId = null;
    this.phoneNumberId = null;
  }

  get apiKey() {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('Missing env var: ELEVENLABS_API_KEY');
    return key;
  }

  async start(server, engine, config) {
    this.engine = engine;
    this.webhookUrl = config.webhookUrl;
    this.strategy = config.strategy;
    this.agentId = process.env.ELEVENLABS_AGENT_ID || null;
    this.phoneNumberId =
      config.providersConfig?.transport?.elevenlabs?.phone_number_id || null;
    logger.log('transport_started', { transport: 'elevenlabs', webhookUrl: this.webhookUrl });
  }

  buildAssistantConfig(strategy, providers, webhookUrl) {
    throw new Error('not implemented yet');
  }

  async createCall(assistantId, phoneNumber, variables = {}) {
    throw new Error('not implemented yet');
  }
}

module.exports = ElevenLabsTransportAdapter;
```

- [ ] **Step 4: Register it**

In `src/adapters/transport/registry.js`, add the require beside the others and the map entry:

```js
const ElevenLabsTransportAdapter = require('./elevenlabs');
```

```js
const TRANSPORT_ADAPTERS = {
  vapi: VapiTransportAdapter,
  elevenlabs: ElevenLabsTransportAdapter,
  playground: PlaygroundTransportAdapter,
};
```

Export the map so the test can read it — at the bottom of the file, alongside the existing export:

```js
module.exports.TRANSPORT_ADAPTERS = TRANSPORT_ADAPTERS;
```

- [ ] **Step 5: Add the config block**

In `config/providers.yaml`, under `transport:`, after the `vapi:` block:

```yaml
  elevenlabs:
    # OUTBOUND ONLY. While this is active.transport, inbound calls are not
    # answered by this server — the number still rings and nothing handles it.
    # Switch back to vapi for the inbound path.
    api_key_env: "ELEVENLABS_API_KEY"
    agent_id_env: "ELEVENLABS_AGENT_ID"
    phone_number_id: "phnum_2001m0m0dch2fvhv1jar36bfzd5p"
```

- [ ] **Step 6: Run tests and commit**

```bash
cd agent && node --test tests/elevenlabs-transport.test.js && npm test
git add agent/src/adapters/transport/elevenlabs.js agent/src/adapters/transport/registry.js agent/config/providers.yaml agent/tests/elevenlabs-transport.test.js
git commit -m "feat: register an ElevenLabs transport adapter behind TransportPort"
```

---

### Task 4: `buildAssistantConfig` — generate the agent patch

**Files:**
- Modify: `src/adapters/transport/elevenlabs.js`
- Test: `tests/elevenlabs-transport.test.js`

**Interfaces:**
- Consumes: `strategy.buildSystemPrompt(variables)`, `strategy.buildFirstMessage(variables)`, `strategy.getTools()` — all on `src/core/strategy/base.js`
- Produces: `buildAssistantConfig(strategy, providers, webhookUrl)` returning `{ conversation_config: { agent: { prompt: { prompt, llm, tools }, first_message, language }, tts: { voice_id, model_id } } }`; and `_toolDeclaration(tool, webhookUrl)` returning one ElevenLabs webhook-tool object

- [ ] **Step 1: Write the failing test**

```js
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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: FAIL — `not implemented yet`

- [ ] **Step 3: Implement**

Replace the `buildAssistantConfig` stub in `src/adapters/transport/elevenlabs.js`:

```js
  /**
   * One ElevenLabs webhook tool from one strategy tool.
   *
   * The shape is taken from a live tool on the source agent, not from the prose
   * docs, which do not specify it. `execution_mode` mirrors tools.json's `async`
   * flag: report_outcome is synchronous because two of its outcomes alert the
   * family, and the agent must not talk past a write that has not landed.
   */
  _toolDeclaration(tool, webhookUrl) {
    const fn = tool.function || tool;
    const params = fn.parameters || { type: 'object', properties: {}, required: [] };
    return {
      type: 'webhook',
      name: fn.name,
      description: fn.description,
      response_timeout_secs: 10,
      execution_mode: tool.async === true ? 'async' : 'sync',
      api_schema: {
        kind: 'webhook',
        url: `${webhookUrl}/el/tools/${fn.name}`,
        method: 'POST',
        request_headers: {},
        path_params_schema: {},
        query_params_schema: null,
        request_body_schema: {
          type: 'object',
          description: fn.description,
          properties: params.properties,
          required: params.required || [],
        },
      },
    };
  }

  /**
   * The agent patch.
   *
   * Generated from the active strategy every time rather than hand-maintained,
   * so a guardrail edit lands on both transports or neither. SETUP.md records a
   * stale config/assistant.json shipping v1 guardrails while the repo ran v4;
   * this is how that does not happen again.
   */
  buildAssistantConfig(strategy, providers, webhookUrl) {
    const variables = typeof strategy.getVariables === 'function' ? strategy.getVariables() : {};
    return {
      conversation_config: {
        agent: {
          language: 'hi',
          first_message: strategy.buildFirstMessage(variables),
          prompt: {
            prompt: strategy.buildSystemPrompt(variables),
            llm: 'gemini-2.5-flash',
            tools: strategy.getTools().map((t) => this._toolDeclaration(t, webhookUrl)),
          },
        },
        tts: {
          voice_id: 'QTKSa2Iyv0yoxvXY2V8a',
          model_id: 'eleven_v3_conversational',
        },
      },
    };
  }
```

- [ ] **Step 4: Run tests and watch them pass**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Full suite, then commit**

```bash
cd agent && npm test
git add agent/src/adapters/transport/elevenlabs.js agent/tests/elevenlabs-transport.test.js
git commit -m "feat: generate the ElevenLabs agent config from the active strategy"
```

---

### Task 5: Tool webhook routes

**Files:**
- Modify: `src/adapters/transport/elevenlabs.js` (`start`)
- Test: `tests/elevenlabs-tools.test.js` (create)

**Interfaces:**
- Consumes: `config.app` (Express app), `engine.getEventBus()`
- Produces: `POST /el/tools/report_outcome` and `POST /el/tools/capture_field`, each returning `{ ok: true }` on success

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const ElevenLabsTransportAdapter = require('../src/adapters/transport/elevenlabs');

function harness() {
  const app = express();
  app.use(express.json());
  const seen = [];
  const engine = { getEventBus: () => ({ emit: (name, payload) => seen.push({ name, payload }) }) };
  const adapter = new ElevenLabsTransportAdapter({});
  adapter.start(null, engine, { app, webhookUrl: 'https://x', strategy: {} });
  return { app, seen };
}

async function post(app, path, body) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('ElevenLabs tool webhooks', () => {
  test('report_outcome reaches the engine', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine',
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(seen[0].name, 'tool:report_outcome');
    assert.strictEqual(seen[0].payload.outcome, 'CONFIRMED');
  });

  test('capture_field passes the caller words through untouched', async () => {
    const { app, seen } = harness();
    await post(app, '/el/tools/capture_field', {
      field: 'chief_complaint', value: 'seene mein bhaaripan hai',
    });
    // Verbatim is a safety property, not a nicety: paraphrase loses evidence.
    assert.strictEqual(seen[0].payload.value, 'seene mein bhaaripan hai');
  });

  test('an unknown tool is refused, not silently accepted', async () => {
    const { app } = harness();
    const res = await post(app, '/el/tools/drop_database', { x: 1 });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.ok, false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/elevenlabs-tools.test.js`
Expected: FAIL — 404 on `/el/tools/report_outcome`

- [ ] **Step 3: Implement**

Add to `start()` in `src/adapters/transport/elevenlabs.js`, before the `logger.log` line:

```js
    const KNOWN_TOOLS = new Set(['report_outcome', 'capture_field']);

    if (config.app) {
      config.app.post('/el/tools/:name', async (req, res) => {
        const name = req.params.name;

        // Allow-list rather than pass-through. This endpoint is public through
        // the tunnel, and forwarding an arbitrary name into the event bus would
        // let anyone who finds the URL emit events the engine acts on.
        if (!KNOWN_TOOLS.has(name)) {
          logger.log('el_tool_unknown', { name });
          return res.status(404).json({ ok: false, error: 'unknown tool' });
        }

        try {
          this.engine.getEventBus().emit(`tool:${name}`, req.body || {});
          logger.log('el_tool_dispatched', { name });
          return res.json({ ok: true });
        } catch (err) {
          logger.log('el_tool_failed', { name, error: err.message });
          return res.status(500).json({ ok: false, error: err.message });
        }
      });
    }
```

- [ ] **Step 4: Run tests and watch them pass**

Run: `cd agent && node --test tests/elevenlabs-tools.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Full suite, then commit**

```bash
cd agent && npm test
git add agent/src/adapters/transport/elevenlabs.js agent/tests/elevenlabs-tools.test.js
git commit -m "feat: route ElevenLabs tool calls into the conversation engine"
```

---

### Task 6: `createCall` — outbound dispatch

**Files:**
- Modify: `src/adapters/transport/elevenlabs.js`
- Test: `tests/elevenlabs-transport.test.js`

**Interfaces:**
- Consumes: `process.env.ELEVENLABS_AGENT_ID`, config `phone_number_id`
- Produces: `createCall(assistantId, phoneNumber, variables)` returning the parsed ElevenLabs response

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: FAIL — `not implemented yet`

- [ ] **Step 3: Implement**

Replace the `createCall` stub, (`this.phoneNumberId` is already set in `start()` from Task 3):

```js
  /**
   * Dispatch an outbound call.
   *
   * Endpoint and required fields come from the ElevenLabs OpenAPI spec
   * (/v1/convai/twilio/outbound-call requires agent_id, agent_phone_number_id
   * and to_number), not from the prose docs, which describe only the dashboard
   * flow.
   */
  async createCall(assistantId, phoneNumber, variables = {}) {
    if (!this.phoneNumberId) {
      throw new Error(
        'Missing phone_number_id for the elevenlabs transport. Set it under ' +
          'transport.elevenlabs in config/providers.yaml — an outbound call has ' +
          'no number to call from without it.'
      );
    }

    const res = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: assistantId,
        agent_phone_number_id: this.phoneNumberId,
        to_number: phoneNumber,
        conversation_initiation_client_data: { dynamic_variables: variables },
      }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs createCall error (${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    logger.log('el_call_created', { conversationId: body.conversation_id });
    return body;
  }
```

- [ ] **Step 4: Run tests and watch them pass**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: PASS

- [ ] **Step 5: Full suite, then commit**

```bash
cd agent && npm test
git add agent/src/adapters/transport/elevenlabs.js agent/tests/elevenlabs-transport.test.js
git commit -m "feat: dispatch outbound calls through the ElevenLabs Twilio endpoint"
```

---

### Task 7: Re-patch the agent on boot

The stored tool URLs point at whatever tunnel was live when they were written. Free-tier ngrok rotates, which is how the source agent came to point at a dead host.

**Files:**
- Modify: `src/adapters/transport/elevenlabs.js` (`start`)
- Test: `tests/elevenlabs-transport.test.js`

**Interfaces:**
- Produces: `async _patchAgent(agentId, config)` — PATCHes `/v1/convai/agents/{id}`

- [ ] **Step 1: Write the failing test**

```js
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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: FAIL — no PATCH is made

- [ ] **Step 3: Implement**

Add the method, and call it at the end of `start()`:

```js
  /**
   * Push the current config to the agent.
   *
   * Called on every boot rather than by a setup script, because the tool URLs
   * embed the tunnel origin and the free ngrok tier rotates it on restart. The
   * source agent still points at a host that stopped resolving weeks ago; tool
   * calls failed silently the whole time. Re-patching makes that unreachable.
   */
  async _patchAgent(agentId, config) {
    const res = await fetch(`${API}/v1/convai/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs agent patch failed (${res.status}): ${await res.text()}`);
    }
    logger.log('el_agent_patched', { agentId, webhookUrl: this.webhookUrl });
    return res.json();
  }
```

At the end of `start()`:

```js
    if (this.agentId && this.strategy && typeof this.strategy.getTools === 'function') {
      await this._patchAgent(this.agentId, this.buildAssistantConfig(this.strategy, {}, this.webhookUrl));
    } else if (!this.agentId) {
      // Loud, because the alternative is a transport that starts fine and never
      // works. Run `npm run setup-elevenlabs` and record the printed id.
      logger.log('el_agent_id_missing', { hint: 'run npm run setup-elevenlabs' });
    }
```

- [ ] **Step 4: Run tests and watch them pass**

Run: `cd agent && node --test tests/elevenlabs-transport.test.js`
Expected: PASS

- [ ] **Step 5: Full suite, then commit**

```bash
cd agent && npm test
git add agent/src/adapters/transport/elevenlabs.js agent/tests/elevenlabs-transport.test.js
git commit -m "feat: re-patch the ElevenLabs agent on boot so tool URLs match the live tunnel"
```

---

### Task 8: Post-call webhook

The spec's comparison rests on both pipelines landing in the same `calls` table, so
`scripts/ground-truth.js` scores them unchanged. Without this the ElevenLabs side has no
transcript, duration or cost to compare.

**Files:**
- Modify: `src/adapters/transport/elevenlabs.js` (`start`)
- Test: `tests/elevenlabs-tools.test.js`

**Interfaces:**
- Consumes: the repository on `config.repository`
- Produces: `POST /el/post-call`, returning `{ ok: true }`

- [ ] **Step 1: Write the failing test**

```js
describe('ElevenLabs post-call webhook', () => {
  test('records the call so both pipelines land in one table', async () => {
    const saved = [];
    const app = express();
    app.use(express.json());
    const adapter = new ElevenLabsTransportAdapter({});
    await adapter.start(null, { getEventBus: () => ({ emit() {} }) }, {
      app,
      webhookUrl: 'https://x',
      strategy: {},
      repository: { saveCall: async (c) => { saved.push(c); } },
    });

    const res = await post(app, '/el/post-call', {
      conversation_id: 'conv_1',
      transcript: [{ role: 'agent', message: 'Namaste' }],
      metadata: { call_duration_secs: 42, cost: 0.031 },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].callId, 'conv_1');
    assert.strictEqual(saved[0].durationSeconds, 42);
    // outcome_source is what tells the A/B which stack produced the row.
    assert.strictEqual(saved[0].outcomeSource, 'elevenlabs');
  });

  test('a malformed payload is refused rather than written half-formed', async () => {
    const app = express();
    app.use(express.json());
    const adapter = new ElevenLabsTransportAdapter({});
    await adapter.start(null, { getEventBus: () => ({ emit() {} }) }, {
      app, webhookUrl: 'https://x', strategy: {}, repository: { saveCall: async () => {} },
    });
    const res = await post(app, '/el/post-call', { transcript: [] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && node --test tests/elevenlabs-tools.test.js`
Expected: FAIL — 404 on `/el/post-call`

- [ ] **Step 3: Implement**

In `start()`, after the tool route, and capture `this.repository = config.repository` at the top of `start()`:

```js
    if (config.app) {
      config.app.post('/el/post-call', async (req, res) => {
        const body = req.body || {};
        const callId = body.conversation_id;

        // Refuse rather than write a row with no identity: a call record that
        // cannot be joined to anything is worse than no record, because it
        // counts in the comparison while describing nothing.
        if (!callId) {
          logger.log('el_post_call_rejected', { reason: 'no conversation_id' });
          return res.status(400).json({ ok: false, error: 'conversation_id required' });
        }

        try {
          await this.repository.saveCall({
            callId,
            transcript: JSON.stringify(body.transcript || []),
            durationSeconds: body.metadata?.call_duration_secs ?? null,
            cost: body.metadata?.cost ?? null,
            recordingUrl: body.metadata?.recording_url ?? null,
            // The whole point of the A/B: which stack produced this row.
            outcomeSource: 'elevenlabs',
          });
          logger.log('el_post_call_saved', { callId });
          return res.json({ ok: true });
        } catch (err) {
          logger.log('el_post_call_failed', { callId, error: err.message });
          return res.status(500).json({ ok: false, error: err.message });
        }
      });
    }
```

- [ ] **Step 4: Check the repository method name matches**

Run: `cd agent && grep -n "async saveCall\|saveCall(" src/adapters/persistence/sqlite.js | head -3`

If the method is named differently, use the real name in both the test double and the
implementation. Do not add a new repository method — the `calls` table already has
`transcript`, `duration_seconds`, `cost`, `recording_url` and `outcome_source`.

- [ ] **Step 5: Run tests and watch them pass**

Run: `cd agent && node --test tests/elevenlabs-tools.test.js`
Expected: PASS

- [ ] **Step 6: Register the webhook with ElevenLabs**

Add to the `buildAssistantConfig` return, inside `conversation_config`:

```js
        platform_settings: {
          workspace_overrides: {
            webhooks: { post_call_webhook_url: `${webhookUrl}/el/post-call` },
          },
        },
```

Then confirm the shape is accepted:

Run: `cd agent && node -e "const d=require('/private/tmp/claude-501/-Users-nishant-Desktop-projects-sahay/f3979b0b-f4f2-4e2b-a393-c851d9008b74/scratchpad/el-openapi.json');console.log(Object.keys(d.components.schemas).filter(k=>/PostCall|Webhook/i.test(k)).slice(0,10))"`

If the spec names a different field, use that one. **Verify against the OpenAPI spec
rather than guessing** — the prose docs do not specify this shape.

- [ ] **Step 7: Full suite, then commit**

```bash
cd agent && npm test
git add agent/src/adapters/transport/elevenlabs.js agent/tests/elevenlabs-tools.test.js
git commit -m "feat: record ElevenLabs calls into the shared calls table for comparison"
```

---

### Task 9: Integration check via simulated conversation

Exercises the real agent and its real tool calls against the running server. No phone call, no call minutes.

**Files:**
- Create: `scripts/simulate-elevenlabs-call.js`

**Interfaces:**
- Consumes: everything above; the agent server must be running with a live `WEBHOOK_URL`

- [ ] **Step 1: Write the script**

```js
'use strict';
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

/**
 * Drive the agent through a scripted conversation and report which tools fired.
 *
 * This is the integration test. It reaches the real ElevenLabs agent and the
 * real tool webhooks over the tunnel, without ringing anyone — so the whole
 * outbound path can be proven before a single real call is placed.
 */
async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key) throw new Error('Missing env var: ELEVENLABS_API_KEY');
  if (!agentId) throw new Error('Missing env var: ELEVENLABS_AGENT_ID — run npm run setup-elevenlabs');

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${agentId}/simulate-conversation`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        simulation_specification: {
          simulated_user_config: {
            first_message: 'Haan bhai, bolo',
            prompt: {
              prompt:
                'You are Kamala, a 71-year-old woman in Pune. You HAVE taken your morning ' +
                'medicine. Answer briefly in Hindi. Confirm you took it when asked.',
            },
          },
        },
      }),
    }
  );

  if (!res.ok) throw new Error(`simulate failed (${res.status}): ${await res.text()}`);
  const body = await res.json();

  const turns = body.simulated_conversation || [];
  console.log(`\n${turns.length} turns\n`);
  for (const t of turns) {
    if (t.message) console.log(`  ${t.role}: ${t.message}`);
    for (const call of t.tool_calls || []) {
      console.log(`  >> TOOL ${call.tool_name} ${JSON.stringify(call.params_as_json || {})}`);
    }
  }
  const fired = turns.flatMap((t) => (t.tool_calls || []).map((c) => c.tool_name));
  console.log(`\ntools fired: ${fired.length ? fired.join(', ') : 'NONE — check WEBHOOK_URL and the agent patch'}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `agent/package.json` `scripts`:

```json
"simulate-elevenlabs": "node scripts/simulate-elevenlabs-call.js"
```

- [ ] **Step 3: Run the whole thing**

```bash
# terminal 1
ngrok http 3001
# put the https origin in agent/.env as WEBHOOK_URL

# terminal 2
cd agent && npm start          # boots, patches the agent with the live tunnel

# terminal 3
cd agent && npm run simulate-elevenlabs
```

Expected: a Hindi conversation, and `tools fired: report_outcome`.

- [ ] **Step 4: Check the outcome landed**

Run: `cd agent && node -e "const R=require('./src/adapters/persistence/sqlite.js');const r=new R();console.log(r.db.prepare('SELECT status, actor, slot_time FROM dose_events ORDER BY rowid DESC LIMIT 3').all())"`
Expected: a row reflecting the simulated outcome.

- [ ] **Step 5: Commit**

```bash
git add agent/scripts/simulate-elevenlabs-call.js agent/package.json
git commit -m "feat: simulate an ElevenLabs call end to end without dialling anyone"
```

---

## Done when

- `active.transport: elevenlabs` boots, patches the agent, and serves the tool webhooks.
- `npm run simulate-elevenlabs` produces a Hindi conversation in which `report_outcome` fires and lands in `dose_events`.
- `npm test` is 588 + the new tests, all green.
- Switching back to `active.transport: vapi` restores the previous behaviour exactly.

## Deliberately not done

- Inbound calls. While `elevenlabs` is active the number rings and nothing answers.
- The post-call webhook writing transcript, recording and cost into `calls`. The comparison can start from `dose_events` and simulation output; add it when a real call is first placed.
- Any real phone call. That needs explicit human approval.
