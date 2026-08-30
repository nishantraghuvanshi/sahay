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
      // every assertion below would pass for the wrong reason.
      API_KEY,
      DISABLE_GUARDRAILS: 'false',
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
});
