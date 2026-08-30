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

describe('boot log — a DB_PATH shaped like a URL is coarsened, never parsed', () => {
  // Round 3: after two rounds of bypassed selective-redaction (a password
  // containing '@', then one containing '/', then one containing both),
  // the approach changed entirely — no parsing. Any value containing "://"
  // collapses to "<scheme>://<redacted>" by construction, so no userinfo
  // character can ever survive regardless of what it contains. Contained
  // inside a tmpdir per test so cleanup removes everything SqliteRepository
  // creates on disk from the RAW (unredacted) value — that write happens
  // before this function ever runs; redaction only protects the log line.
  // Built with template-literal concatenation, not path.join/path.resolve,
  // which would collapse "://" to "/" before the value ever reaches
  // redactCredentials() and hide the scheme this test means to exercise.
  async function assertCoarsened({ dbDir, dbPathValue, secret }) {
    const handle = spawnServer({
      DB_PATH: dbPathValue,
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
      assert.ok(line.db_path, 'db_path should still be present');
      assert.ok(!line.db_path.includes(secret), 'db_path field itself must not carry the secret');
      assert.ok(line.db_path.includes('<redacted>'), 'db_path should be coarsened, not dropped or left raw');
      // No '@' surviving anywhere is the structural guarantee this round is
      // built on — not "the password is gone" but "userinfo cannot exist in
      // the output at all", checked by construction, not by pattern.
      assert.ok(!line.db_path.includes('@'), 'no authority/userinfo delimiter should survive coarsening');
    } finally {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  }

  test('a password containing an unencoded @ is redacted (round-1 bypass)', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-at-'));
    const secret = 'pa@ssXYZsecret';
    await assertCoarsened({
      dbDir,
      dbPathValue: `${dbDir}/postgresql://kinvox:${secret}@localhost:5432/kinvox`,
      secret,
    });
  });

  test('a password containing an unencoded / is redacted (round-2 bypass)', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-slash-'));
    const secret = 'pw-with-slash-secret';
    await assertCoarsened({
      dbDir,
      dbPathValue: `${dbDir}/postgresql://kinvox:pw/with/${secret}@localhost:5432/db`,
      secret,
    });
  });

  test('a password containing BOTH @ and / is redacted (round-3 finding)', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-both-'));
    const secret = 'ss-wo-secret';
    await assertCoarsened({
      dbDir,
      dbPathValue: `${dbDir}/postgresql://kinvox:pa@${secret}/wo@localhost:5432/db`,
      secret,
    });
  });

  test('a password that is itself a URL is redacted', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-nested-url-'));
    const secret = 'nested-secret-token';
    await assertCoarsened({
      dbDir,
      dbPathValue: `${dbDir}/postgresql://user:http://${secret}@evil.example@localhost:5432/db`,
      secret,
    });
  });

  test('sqlite:/// (three slashes, no authority) is coarsened too', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-triple-slash-'));
    // No credential to leak here — this proves the "contains ://" rule is
    // unconditional, not gated on finding userinfo first.
    await assertCoarsened({
      dbDir,
      dbPathValue: `${dbDir}/sqlite:///abs/path.db`,
      secret: 'abs/path.db',
    });
  });

  test('a path merely containing an embedded scheme:// is coarsened, not mangled into a false path', async () => {
    // The re-review's own example was /mnt/backups/scp://deploy:build@2024/
    // release.db — reproduced here under a writable tmpdir instead of a
    // literal /mnt path, which this machine cannot write to regardless of
    // redaction. What matters is proven either way: a value with a
    // legitimate-looking directory prefix in front of an embedded "scp://"
    // must not come out as a rewritten path that silently points somewhere
    // else — it must come out as the coarse form, so an operator sees the
    // value was suspect rather than trusting a corrupted path.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-boot-log-embedded-scheme-'));
    const secret = 'build-secret-2024';
    await assertCoarsened({
      dbDir,
      dbPathValue: `${dbDir}/backups/scp://deploy:${secret}@host/release.db`,
      secret,
    });
  });
});

describe('boot log — an ordinary filesystem path passes through byte-identical', () => {
  test('legitimate paths containing @ or : are never touched', async () => {
    // Must matter more than the leak: a redactor that corrupts a real path
    // breaks database selection. Neither of these contains "://", so
    // redactCredentials() must return the exact same value, not a rewrite
    // that merely happens to look the same.
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
          // Byte-identical to the resolved value, by strict equality — not
          // "looks the same", the literal same string.
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
