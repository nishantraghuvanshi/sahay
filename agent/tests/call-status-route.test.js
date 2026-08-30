'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Task 2 — both outbound-call routes must ask the ACTIVE transport for what
 * it needs instead of reading a Vapi-only env var or calling api.vapi.ai
 * directly.
 *
 * dialPatient() (the scheduler's dial path) used to read VAPI_ASSISTANT_ID
 * unconditionally: harmless-looking under Vapi, but under ElevenLabs it
 * silently handed a Vapi assistant id to ElevenLabs as its agent_id instead
 * of throwing on a missing var — the CRITICAL fixed by this task. This file
 * doesn't reach dialPatient directly (that needs SCHEDULER_ENABLED, which is
 * out of scope to touch here); it instead proves the same fact through
 * POST /api/call (which shares dialPatient's fixed sibling,
 * transport.getAssistantId()) and GET /api/call/:callId (the new
 * transport.getCallStatus() delegation), boots the real assembled server —
 * route wiring like this isn't expressible as a unit test — under BOTH
 * transports, and asserts neither route can be made to answer with a
 * Vapi-flavoured error while ElevenLabs is active, or vice versa.
 *
 * Same harness shape as server-boot-auth.test.js / resume-e2e.test.js:
 * spawn the real server.js, wait for /health, assert against the live app.
 */

const API_KEY = 'test-api-key-not-a-real-secret';
const VAPI_SECRET = 'test-vapi-secret-not-a-real-secret';
const ELEVENLABS_WEBHOOK_SECRET = 'test-el-webhook-secret-not-real';
const ELEVENLABS_POST_CALL_SECRET = 'test-el-post-call-secret-not-real';

async function waitForHealth(url, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return false;
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Boots the real server.js with the given transport active and an isolated
 * DB. `envOverrides` deliberately blanks out the vendor vars the local .env
 * happens to have set (see task-2-report.md) so each scenario tests the
 * absence it claims to test rather than whatever this machine's .env
 * contains — dotenv (called inside the spawned process) does not override a
 * key already present in its env, even an empty-string one, so passing '' here
 * is enough to suppress the .env value.
 */
function bootServer(transport, envOverrides = {}) {
  const state = { proc: null, baseUrl: null, dbDir: null, bootFailed: false, bootStderr: '' };

  state.dbDir = fs.mkdtempSync(path.join(os.tmpdir(), `sahay-call-status-${transport}-`));
  const port = 20000 + Math.floor(Math.random() * 20000);
  state.baseUrl = `http://127.0.0.1:${port}`;

  state.proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(state.dbDir, 'test.db'),
      API_KEY,
      VAPI_SECRET,
      DISABLE_GUARDRAILS: 'false',
      TRANSPORT: transport,
      ELEVENLABS_WEBHOOK_SECRET,
      ELEVENLABS_POST_CALL_SECRET,
      ...envOverrides,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  state.proc.stderr.on('data', (chunk) => {
    state.bootStderr += chunk.toString();
  });

  return state;
}

async function readyOrFail(state) {
  const healthy = await waitForHealth(state.baseUrl, state.proc);
  if (!healthy) {
    state.bootFailed = true;
    if (state.proc.exitCode === null && state.proc.signalCode === null) {
      state.proc.kill();
    }
  }
}

function teardown(state) {
  if (state.proc && state.proc.exitCode === null && state.proc.signalCode === null) {
    state.proc.kill();
  }
  if (state.dbDir) {
    fs.rmSync(state.dbDir, { recursive: true, force: true });
  }
}

function requireBooted(state) {
  if (state.bootFailed) {
    assert.fail(`server failed to boot:\n${state.bootStderr}`);
  }
}

const CALL_BODY = {
  phone: '+919876543210',
  name: 'Sharma-ji',
  drug: 'Crocin',
};

describe('POST /api/call — asks the active transport, never one vendor by name', () => {
  describe('vapi active, VAPI_ASSISTANT_ID unset', () => {
    let state;
    before(async () => {
      state = bootServer('vapi', { VAPI_ASSISTANT_ID: '' });
      await readyOrFail(state);
    });
    after(() => teardown(state));

    test('fails naming the Vapi var, not a generic or ElevenLabs error', async () => {
      requireBooted(state);
      const res = await fetch(`${state.baseUrl}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(CALL_BODY),
      });
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /VAPI_ASSISTANT_ID/);
      assert.doesNotMatch(body.error, /ELEVENLABS/);
    });
  });

  describe('elevenlabs active, ELEVENLABS_AGENT_ID unset', () => {
    let state;
    before(async () => {
      // Blanked explicitly, per bootServer's contract above. This passed an
      // empty override while agent/.env simply had no ELEVENLABS_AGENT_ID line,
      // so the scenario was resting on a machine's local config rather than
      // asserting the absence it names — and started failing the moment a real
      // agent id was configured.
      state = bootServer('elevenlabs', { ELEVENLABS_AGENT_ID: '' });
      await readyOrFail(state);
    });
    after(() => teardown(state));

    test('fails naming the ElevenLabs var — never falls back to a Vapi id', async () => {
      requireBooted(state);
      const res = await fetch(`${state.baseUrl}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(CALL_BODY),
      });
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /ELEVENLABS_AGENT_ID/);
      assert.doesNotMatch(body.error, /VAPI_ASSISTANT_ID/);
    });
  });
});

describe('GET /api/call/:callId — delegates to transport.getCallStatus()', () => {
  describe('vapi active, VAPI_PRIVATE_KEY unset', () => {
    let state;
    before(async () => {
      state = bootServer('vapi', { VAPI_PRIVATE_KEY: '' });
      await readyOrFail(state);
    });
    after(() => teardown(state));

    test('reports the missing Vapi credential without ever reaching api.vapi.ai', async () => {
      requireBooted(state);
      const res = await fetch(`${state.baseUrl}/api/call/some-call-id`, {
        headers: { 'x-api-key': API_KEY },
      });
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /VAPI_PRIVATE_KEY/);
    });
  });

  describe('elevenlabs active', () => {
    let state;
    before(async () => {
      state = bootServer('elevenlabs', {});
      await readyOrFail(state);
    });
    after(() => teardown(state));

    test('reports unsupported rather than 500ing against api.vapi.ai or faking a status', async () => {
      requireBooted(state);
      const res = await fetch(`${state.baseUrl}/api/call/some-call-id`, {
        headers: { 'x-api-key': API_KEY },
      });
      // Preserves this route's pre-existing non-200-on-error contract — it is
      // caregiver-app-facing, not a tool endpoint bound by NFR-6's always-200
      // rule.
      assert.strictEqual(res.status, 501);
      const body = await res.json();
      assert.strictEqual(body.error, 'unsupported');
    });
  });

  describe('an unauthenticated request', () => {
    let state;
    before(async () => {
      state = bootServer('vapi', {});
      await readyOrFail(state);
    });
    after(() => teardown(state));

    test('is rejected before ever reaching the transport', async () => {
      requireBooted(state);
      const res = await fetch(`${state.baseUrl}/api/call/some-call-id`);
      assert.strictEqual(res.status, 401);
    });
  });
});
