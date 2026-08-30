'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Boots the real src/server.js and checks that PHI routes are actually behind
 * authentication.
 *
 * This exists because of a proven hole: an audit deleted
 * `app.use('/api/playground', apiKeyAuth)` from server.js outright and the full
 * suite still passed 588/588. Nothing booted the real server and hit an /api
 * route, so the one bug this codebase has already shipped once — a PHI endpoint
 * registered above its guard, because Express walks a single ordered stack —
 * was invisible to every test.
 *
 * Route order is not expressible as a unit test. It only exists in the
 * assembled application, so this test asserts against the assembled one.
 *
 * resume-e2e.test.js already spawns the server this way; the harness below is
 * deliberately the same shape so there is one pattern to learn, not two.
 */

const API_KEY = 'test-api-key-not-a-real-secret';
const VAPI_SECRET = 'test-vapi-secret-not-a-real-secret';

let serverProcess = null;
let baseUrl = null;
let dbDir = null;
let bootFailed = false;
let bootStderr = '';

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

before(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-auth-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  baseUrl = `http://127.0.0.1:${port}`;

  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dbDir, 'test.db'),
      // Set explicitly: with API_KEY absent, apiKeyAuth skips auth entirely and
      // every assertion below would pass for the wrong reason. Same story for
      // VAPI_SECRET — vapiSecretAuth would reject every request below with
      // VAPI_SECRET unset, and every assertion would fail for the wrong reason.
      API_KEY,
      VAPI_SECRET,
      DISABLE_GUARDRAILS: 'false',
      // Pinned: main made ElevenLabs the default transport, and that one is
      // outbound-only — it mounts no /api/stt and no custom-LLM route, so
      // every auth assertion below would 404 instead of 401. This file tests
      // the Vapi path's auth, so it must name the transport it needs.
      TRANSPORT: 'vapi',
      // Forced empty, not merely absent — the same reason spelled out at the
      // sibling spawn below, which this block was missing: agent/.env sets
      // ALLOW_INSECURE_LOCAL=1 for local work, and dotenv (called inside
      // server.js) does not override a key already present in its env. With
      // it inherited, assertSafeToServe() short-circuits and this block boots
      // through a path it never chose.
      ALLOW_INSECURE_LOCAL: '',
      // ...and once it no longer short-circuits, the real safety gate runs,
      // which is where this block turned out to have been leaning on
      // agent/.env for a value it never declared: without ALERT_OPERATOR_CONTACT
      // the server refuses to start. A dummy contact, matching boot-log.test.js
      // — this file tests auth, and never reaches escalation delivery.
      ALERT_OPERATOR_CONTACT: '12345',
      // agent/.env sets CAPTURE_WEBHOOKS=./data/webhooks.jsonl and cwd is
      // agent/, so this spawn was appending to the repo's own working tree.
      CAPTURE_WEBHOOKS: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serverProcess.stderr.on('data', (chunk) => {
    bootStderr += chunk.toString();
  });

  const healthy = await waitForHealth(baseUrl, serverProcess);
  if (!healthy) {
    bootFailed = true;
    if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
      serverProcess.kill();
    }
  }
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill();
  }
  if (dbDir) {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

/** A skip here would be indistinguishable from a pass. Fail with the reason. */
function requireBooted() {
  if (bootFailed) {
    assert.fail(`server failed to boot for the auth boot test:\n${bootStderr}`);
  }
}

// Every route that returns patient data. Adding an /api route without adding it
// here is the mistake this file is meant to catch, so keep the list complete.
const PHI_ROUTES = ['/api/playground/patients', '/api/calls'];

describe('server boot — PHI routes are behind auth in the assembled app', () => {
  test('/health answers without a key (public by design)', async () => {
    requireBooted();
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
  });

  test('every PHI route refuses an unauthenticated request', async () => {
    requireBooted();
    for (const route of PHI_ROUTES) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.strictEqual(
        res.status,
        401,
        `${route} answered ${res.status} without an API key — it is registered above its auth guard`
      );
    }
  });

  test('an unauthenticated refusal returns no patient data', async () => {
    requireBooted();
    for (const route of PHI_ROUTES) {
      const body = await (await fetch(`${baseUrl}${route}`)).text();
      assert.ok(
        !/phone|patients"\s*:\s*\[|caregiver/i.test(body),
        `${route} leaked something patient-shaped in its 401 body: ${body.slice(0, 200)}`
      );
    }
  });

  test('every PHI route answers with a valid key', async () => {
    requireBooted();
    for (const route of PHI_ROUTES) {
      const res = await fetch(`${baseUrl}${route}`, { headers: { 'x-api-key': API_KEY } });
      assert.strictEqual(res.status, 200, `${route} rejected a valid key`);
    }
  });

  test('a wrong key is rejected', async () => {
    requireBooted();
    for (const route of PHI_ROUTES) {
      const res = await fetch(`${baseUrl}${route}`, { headers: { 'x-api-key': 'wrong' } });
      // 403, not 401: auth.js distinguishes "you sent no credential" from
      // "you sent one and it is wrong". Asserting the exact code keeps that
      // distinction from being flattened by a later refactor.
      assert.strictEqual(res.status, 403, `${route} accepted a wrong key`);
    }
  });

  test('/health omits internals without a key, includes them with a valid one', async () => {
    requireBooted();
    const anonymous = await (await fetch(`${baseUrl}/health`)).json();
    assert.strictEqual(anonymous.status, 'ok');
    assert.strictEqual(anonymous.providers, undefined, '/health leaked provider names to an anonymous caller');
    assert.strictEqual(anonymous.persistence, undefined, '/health leaked its persistence class to an anonymous caller');

    const authed = await (
      await fetch(`${baseUrl}/health`, { headers: { 'x-api-key': API_KEY } })
    ).json();
    assert.ok(authed.providers, '/health should include providers for a caller holding the API key');
    assert.ok(authed.persistence, '/health should include persistence for a caller holding the API key');
  });
});

describe('server boot — /webhook and the Vapi bridge endpoints require VAPI_SECRET', () => {
  test('a forged webhook with no secret is rejected, but still answers HTTP 200', async () => {
    requireBooted();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { type: 'end-of-call-report', call: { id: 'forged-call' } } }),
    });
    // NFR-6: a caller may be waiting on this response — /webhook always
    // answers 200, with the rejection carried as data (ok:false), never as
    // transport failure.
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
  });

  test('a correct secret is accepted on /webhook', async () => {
    requireBooted();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': VAPI_SECRET },
      body: JSON.stringify({ message: { type: 'speech-update', call: { id: 'ok-call' } } }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.notStrictEqual(body.ok, false);
  });

  test('a wrong secret is rejected on /webhook, still HTTP 200', async () => {
    requireBooted();
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'wrong-secret' },
      body: JSON.stringify({ message: { type: 'speech-update', call: { id: 'wrong-call' } } }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
  });

  test('/llm/chat/completions rejects unauthenticated access with a real 401', async () => {
    requireBooted();
    const res = await fetch(`${baseUrl}/llm/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.strictEqual(res.status, 401);
  });

  test('/llm/chat/completions rejects a wrong secret too, still a 401 not a pass-through', async () => {
    requireBooted();
    const res = await fetch(`${baseUrl}/llm/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'wrong-secret' },
      body: JSON.stringify({ messages: [] }),
    });
    // Deliberately does NOT test a correct-secret request through to the
    // LLM provider — that would place a real call against the configured
    // vendor. The unit tests in auth.test.js already cover the accept path
    // for vapiSecretAuth against a fake app.
    assert.strictEqual(res.status, 401, 'a wrong secret must still be rejected');
  });

  test('the /api/stt WebSocket rejects a connection with no secret', async () => {
    requireBooted();
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/stt';
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const closeCode = await new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {}); // an abrupt close can also fire a socket error; ignore it, close is what's asserted
    });
    // 4001: same "unauthorized" close code the playground WS already uses
    // (server.js) for an invalid/missing key — one convention, not two.
    assert.strictEqual(closeCode, 4001);
  });

  test('the /api/stt WebSocket accepts a connection with the matching secret', async () => {
    requireBooted();
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/stt?api_key=${VAPI_SECRET}`;
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const opened = await new Promise((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('close', () => resolve(false));
      ws.on('error', () => resolve(false));
    });
    ws.close();
    assert.strictEqual(opened, true);
  });
});

describe('generated assistant config carries VAPI_SECRET in all four places', () => {
  test('server.secret, model.headers and the stt query param all carry it', () => {
    const original = process.env.VAPI_SECRET;
    process.env.VAPI_SECRET = VAPI_SECRET;
    try {
      // Cache-busted require: generate-assistant-config.js reads
      // process.env.VAPI_SECRET at call time via buildAssistantConfig, so a
      // fresh require is not required for correctness, but this test only
      // wants a value it just set, not whatever an earlier test left behind.
      delete require.cache[require.resolve('../scripts/generate-assistant-config')];
      const { generate } = require('../scripts/generate-assistant-config');
      const { assistantConfig } = generate();

      assert.strictEqual(assistantConfig.server.secret, VAPI_SECRET, 'webhook server.secret');
      assert.strictEqual(assistantConfig.model.headers['x-vapi-secret'], VAPI_SECRET, 'custom-llm model.headers');
      assert.strictEqual(assistantConfig.transcriber.server.secret, VAPI_SECRET, 'stt transcriber server.secret');
      assert.ok(
        assistantConfig.transcriber.server.url.includes(`api_key=${VAPI_SECRET}`),
        'stt transcriber server.url should carry ?api_key=<secret> for the WS handshake'
      );
    } finally {
      if (original === undefined) delete process.env.VAPI_SECRET;
      else process.env.VAPI_SECRET = original;
    }
  });
});

describe('server boot — refuses to start without VAPI_SECRET', () => {
  test('boot fails when VAPI_SECRET is unset and ALLOW_INSECURE_LOCAL is not set', async () => {
    const failDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-fail-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const failUrl = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: path.join(failDbDir, 'test.db'),
        API_KEY,
        DISABLE_GUARDRAILS: 'false',
        // Pinned: main made ElevenLabs the default transport, and that one is
        // outbound-only — it mounts no /api/stt and no custom-LLM route, so
        // every auth assertion below would 404 instead of 401. This file tests
        // the Vapi path's auth, so it must name the transport it needs.
        TRANSPORT: 'vapi',
        // No VAPI_SECRET. And ALLOW_INSECURE_LOCAL is forced empty, not
        // merely absent — dotenv.config() (called inside server.js) does
        // not override a key that already exists in process.env, even an
        // empty one, so this stops the developer's own .env (which sets
        // ALLOW_INSECURE_LOCAL=1 for local work) from silently bypassing
        // the very check this test exists to prove.
        ALLOW_INSECURE_LOCAL: '',
        CAPTURE_WEBHOOKS: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    try {
      const healthy = await waitForHealth(failUrl, child, 5000);
      assert.strictEqual(healthy, false, 'server should never become healthy without VAPI_SECRET');
      assert.match(stderr, /VAPI_SECRET is not set/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      fs.rmSync(failDbDir, { recursive: true, force: true });
    }
  });
});
