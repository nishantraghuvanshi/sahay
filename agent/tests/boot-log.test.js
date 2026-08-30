'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Boots the real src/server.js and checks the resolved configuration is
 * VISIBLE in the server_listening boot log — active_transport, db_path,
 * auth_mode and webhook_url — and that ALLOW_INSECURE_LOCAL cannot silently
 * bind a network interface.
 *
 * This exists because the boot log used to record active_stt/llm/tts,
 * persistence class and scheduler state, but never which transport was
 * actually serving, where the database file actually was, or whether auth
 * was actually enforced — so `npm start` silently booting the wrong
 * transport, or with insecure mode left on, was invisible.
 *
 * Same spawn-and-wait harness as server-boot-auth.test.js; stdout is
 * captured too so the boot log line itself can be asserted on.
 */

const API_KEY = 'test-api-key-not-a-real-secret';
const VAPI_SECRET = 'test-vapi-secret-not-a-real-secret';

function spawnServer(env, { port } = {}) {
  const resolvedPort = port || 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(resolvedPort), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return {
    child,
    port: resolvedPort,
    baseUrl: `http://127.0.0.1:${resolvedPort}`,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

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

async function waitForExit(proc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function parseServerListeningLine(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.event === 'server_listening') return parsed;
  }
  return null;
}

describe('boot log — resolved configuration is visible (server started, auth enforced)', () => {
  let handle = null;
  let dbDir = null;
  let bootFailed = false;

  before(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-'));
    handle = spawnServer({
      DB_PATH: path.join(dbDir, 'test.db'),
      API_KEY,
      VAPI_SECRET,
      ALERT_OPERATOR_CONTACT: '12345',
      DISABLE_GUARDRAILS: 'false',
      ALLOW_INSECURE_LOCAL: '',
      TRANSPORT: 'vapi',
      // Forced empty, not merely absent: dotenv.config() (called inside
      // server.js) does not override a key already present in process.env,
      // even an empty one, so this stops the developer's own .env (which
      // sets WEBHOOK_URL to a real tunnel host) from making the "matches
      // the localhost fallback" assertion below pass for the wrong reason.
      WEBHOOK_URL: '',
    });
    const healthy = await waitForHealth(handle.baseUrl, handle.child);
    if (!healthy) {
      bootFailed = true;
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
    }
  });

  after(async () => {
    if (handle && handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill();
    }
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function requireBooted() {
    if (bootFailed) assert.fail(`server failed to boot:\n${handle.getStderr()}`);
  }

  test('server_listening carries active_transport, db_path, auth_mode and webhook_url', () => {
    requireBooted();
    const line = parseServerListeningLine(handle.getStdout());
    assert.ok(line, `no server_listening line found in stdout:\n${handle.getStdout()}`);
    assert.strictEqual(line.active_transport, 'vapi');
    assert.strictEqual(line.db_path, path.resolve(path.join(dbDir, 'test.db')));
    assert.strictEqual(line.auth_mode, 'enforced');
    assert.ok(line.webhook_url, 'webhook_url should be present');
  });

  test('webhook_url matches the value actually wired into the transport', () => {
    requireBooted();
    const line = parseServerListeningLine(handle.getStdout());
    assert.ok(line);
    // No WEBHOOK_URL was set, so this must equal the same fallback server.js
    // computes for the transport (http://localhost:${PORT}) — proving the
    // log reused that exact value rather than rebuilding a second one from
    // PORT that could disagree with it.
    assert.strictEqual(line.webhook_url, `http://localhost:${handle.port}`);
  });

  test('db_path is the resolved absolute path, not the raw DB_PATH value', () => {
    requireBooted();
    const line = parseServerListeningLine(handle.getStdout());
    assert.ok(path.isAbsolute(line.db_path));
  });

  test('no secret value is present anywhere in the boot log output', () => {
    requireBooted();
    assert.ok(!handle.getStdout().includes(API_KEY));
    assert.ok(!handle.getStdout().includes(VAPI_SECRET));
  });

  test('auth_mode is enforced and no auth_disabled line was logged', () => {
    requireBooted();
    assert.ok(!/"event":"auth_disabled"/.test(handle.getStdout()));
  });
});

describe('boot log — insecure mode is loud and loopback-only', () => {
  let handle = null;
  let dbDir = null;
  let bootFailed = false;

  before(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-insecure-'));
    handle = spawnServer({
      DB_PATH: path.join(dbDir, 'test.db'),
      // No API_KEY, no VAPI_SECRET, no ALERT_OPERATOR_CONTACT — insecure
      // mode must boot anyway, and every one of those must show up as
      // disabled rather than silently satisfied.
      ALLOW_INSECURE_LOCAL: '1',
      TRANSPORT: 'vapi',
    });
    const healthy = await waitForHealth(handle.baseUrl, handle.child);
    if (!healthy) {
      bootFailed = true;
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
    }
  });

  after(async () => {
    if (handle && handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill();
    }
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function requireBooted() {
    if (bootFailed) assert.fail(`server failed to boot:\n${handle.getStderr()}`);
  }

  test('logs a loud auth_disabled line naming ALLOW_INSECURE_LOCAL', () => {
    requireBooted();
    assert.match(handle.getStdout(), /"event":"auth_disabled"/);
    assert.match(handle.getStdout(), /ALLOW_INSECURE_LOCAL/);
  });

  test('server_listening reports auth_mode INSECURE and binds loopback', () => {
    requireBooted();
    const line = parseServerListeningLine(handle.getStdout());
    assert.ok(line);
    assert.strictEqual(line.auth_mode, 'INSECURE');
    assert.strictEqual(line.host, '127.0.0.1');
  });
});

describe('boot log — an explicit non-loopback bind while insecure refuses to start', () => {
  test('HOST=0.0.0.0 with ALLOW_INSECURE_LOCAL=1 fails closed, naming the conflict', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-refuse-'));
    const handle = spawnServer({
      DB_PATH: path.join(dbDir, 'test.db'),
      ALLOW_INSECURE_LOCAL: '1',
      HOST: '0.0.0.0',
      TRANSPORT: 'vapi',
    });
    try {
      const healthy = await waitForHealth(handle.baseUrl, handle.child, 5000);
      assert.strictEqual(healthy, false, 'server should never become healthy with an explicit non-loopback HOST while insecure');
      const exited = await waitForExit(handle.child);
      assert.ok(exited, 'server should exit rather than hang');
      assert.match(handle.getStderr(), /HOST=0\.0\.0\.0 is not loopback/);
      assert.match(handle.getStderr(), /ALLOW_INSECURE_LOCAL/);
    } finally {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe('boot log — db_path redacts a credential-bearing value', () => {
  // Contained inside a tmpdir per test so cleanup removes everything
  // SqliteRepository creates, unlike the leaked artifact this file is named
  // after. Built with template-literal concatenation, NOT path.join/
  // path.resolve — those collapse "://" down to a single "/" before the
  // value ever reaches redactCredentials(), which would silently defeat the
  // very scheme match this test means to exercise, and does not represent
  // how DB_PATH is actually set in practice (a raw connection string, no
  // unrelated directory prefix).
  async function assertRedacted({ dbDir, connectionStringPath, secret, dbPathPattern }) {
    const handle = spawnServer({
      DB_PATH: connectionStringPath,
      ALLOW_INSECURE_LOCAL: '1',
      TRANSPORT: 'vapi',
    });
    try {
      const healthy = await waitForHealth(handle.baseUrl, handle.child);
      assert.ok(healthy, `server failed to boot:\n${handle.getStderr()}`);

      const stdout = handle.getStdout();
      assert.ok(!stdout.includes(secret), `secret leaked into boot log output: ${stdout}`);

      const line = parseServerListeningLine(stdout);
      assert.ok(line, 'no server_listening line found');
      assert.ok(line.db_path, 'db_path should still be present and useful');
      assert.ok(!line.db_path.includes(secret), 'db_path field itself must not carry the secret');
      assert.match(line.db_path, dbPathPattern, 'db_path should redact to user:***@, not drop the field entirely');
    } finally {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  }

  test('a DB_PATH set to a connection string never puts the password in the log', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-redact-'));
    const password = 'sup3r-secret-pw';
    await assertRedacted({
      dbDir,
      connectionStringPath: `${dbDir}/postgresql://kinvox:${password}@localhost:5432/kinvox`,
      secret: password,
      dbPathPattern: /kinvox:\*\*\*@/,
    });
  });

  test('a password containing an unencoded @ is fully redacted, not just up to the first @', async () => {
    // Regression for the round-1 fix: a first-'@'-scan stops at "pa" and
    // leaves "ssXYZ" — the part after the embedded '@' — in clear text.
    // The real userinfo/host boundary is the LAST '@' before the authority
    // ends, per RFC 3986.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-redact-at-'));
    const password = 'pa@ssXYZsecret';
    await assertRedacted({
      dbDir,
      connectionStringPath: `${dbDir}/postgresql://kinvox:${password}@localhost:5432/kinvox`,
      secret: 'ssXYZsecret', // the part after the embedded '@' — the exact bypass
      dbPathPattern: /kinvox:\*\*\*@localhost:5432\/kinvox$/,
    });
  });

  test('a password containing an unencoded / is fully redacted', async () => {
    // An unencoded '/' inside a password makes the value stop looking like
    // a well-formed URL (the parser would otherwise read it as the start of
    // the path) — must still be redacted, not left in the clear because the
    // string technically isn't a valid URL.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-redact-slash-'));
    const password = 'pw/with/slash-secret';
    await assertRedacted({
      dbDir,
      connectionStringPath: `${dbDir}/postgresql://kinvox:${password}@localhost:5432/db`,
      secret: 'slash-secret',
      dbPathPattern: /kinvox:\*\*\*@localhost:5432\/db$/,
    });
  });

  test('legitimate filesystem paths containing @ or : pass through unmangled', async () => {
    // Must matter more than the leak: a redactor that corrupts a real path
    // breaks database selection. Neither of these contains "://", so
    // redactCredentials() must not touch them at all.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-legit-'));
    const legitPaths = [
      path.join(dbDir, 'a@b', 'x.db'),
      path.join(dbDir, 'a:b', 'x.db'),
    ];
    try {
      for (const dbPath of legitPaths) {
        const handle = spawnServer({
          DB_PATH: dbPath,
          ALLOW_INSECURE_LOCAL: '1',
          TRANSPORT: 'vapi',
        });
        try {
          const healthy = await waitForHealth(handle.baseUrl, handle.child);
          assert.ok(healthy, `server failed to boot for ${dbPath}:\n${handle.getStderr()}`);
          const line = parseServerListeningLine(handle.getStdout());
          assert.ok(line, 'no server_listening line found');
          assert.strictEqual(line.db_path, path.resolve(dbPath), `${dbPath} must pass through byte-identical`);
        } finally {
          if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
        }
      }
    } finally {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
