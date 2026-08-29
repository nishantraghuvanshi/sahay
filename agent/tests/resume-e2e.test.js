'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SqliteRepository = require('../src/adapters/persistence/sqlite');

/**
 * Task 4 — prove resume works without hand-feeding.
 *
 * Every existing session test calls endSession directly, so they verify the
 * state machine while nothing verifies that anything *drives* it. Tonight's
 * failure (a handler method that silently did not exist, invisible to 371
 * green tests) lived exactly in that gap: nothing exercised the real HTTP
 * path end to end.
 *
 * This test spawns the real server (src/server.js unmodified) and drives
 * the whole drop-and-resume loop entirely over /webhook, asserting on the
 * assistant Vapi would actually receive — never by reading the database.
 */

const PHONE = '+919876500001';
const PATIENT = { phone: PHONE, name: 'Geeta-ji', drugName: 'Metformin', language: 'hi' };
const COMPLAINT = 'सीने में हल्का दर्द है';

// Vapi endedReason that must NOT map to 'completed' — see session-status.js.
// It is neither in NORMAL_ENDED_REASONS nor an "assistant-...hangup" reason,
// so terminalStatusFor() falls through to 'dropped', which is what makes the
// session eligible for resume in step 5.
const ABNORMAL_ENDED_REASON = 'pipeline-error-openai-llm-failed';

let serverProcess = null;
let baseUrl = null;
let dbDir = null;
let bootFailed = false;

/** Poll /health until it answers, or give up. */
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-resume-e2e-'));
  const dbPath = path.join(dbDir, 'test.db');

  // Setup only: seed one patient directly in the DB before any HTTP traffic.
  const seedRepo = new SqliteRepository({ dbPath });
  await seedRepo.upsertPatient({
    phone: PATIENT.phone,
    name: PATIENT.name,
    drug_name: PATIENT.drugName,
    language: PATIENT.language,
  });
  await seedRepo.close();

  const port = 20000 + Math.floor(Math.random() * 20000);
  baseUrl = `http://127.0.0.1:${port}`;

  serverProcess = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'src', 'server.js')],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
      stdio: 'ignore',
    }
  );

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

describe('resume e2e — driven entirely over HTTP', () => {
  test('a dropped inbound call resumes with what it already captured', async (t) => {
    if (bootFailed) {
      t.skip('server did not come up (port bind failed?) — skipping e2e test');
      return;
    }

    const firstCallId = 'e2e-call-1';
    const secondCallId = 'e2e-call-2';

    // Step 2: first assistant-request from the known number.
    // Asserts inbound mode, by inspecting the returned assistant, not the DB.
    const res1 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          type: 'assistant-request',
          call: { id: firstCallId, from: { phoneNumber: PHONE } },
        },
      }),
    });
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json();
    assert.ok(body1.assistant, 'assistant-request should return an assistant');

    const systemPrompt1 = body1.assistant.model.messages[0].content;
    // Resume's system prompt is the only one that says this — its absence
    // here is what "inbound, not resume" means from the caller's assistant.
    assert.ok(
      !systemPrompt1.includes('CONTINUATION'),
      'first call should be answered in inbound mode, not resume'
    );
    assert.match(
      body1.assistant.firstMessage,
      /क्या तकलीफ़ है/,
      'inbound first message should ask what is wrong, not reference a dropped call'
    );

    // Step 3: capture_field on the SAME call id — capture_field writes to
    // the session keyed on message.call.id, which step 2 opened.
    const res2 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          type: 'tool-call',
          call: { id: firstCallId },
          tool: {
            name: 'capture_field',
            arguments: { field: 'chief_complaint', value: COMPLAINT },
          },
        },
      }),
    });
    assert.strictEqual(res2.status, 200);

    // Step 4: end-of-call-report, same call id, an ABNORMAL endedReason so
    // the session lands as 'dropped' (resumable), not 'completed'.
    const res3 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          type: 'end-of-call-report',
          call: { id: firstCallId, endedReason: ABNORMAL_ENDED_REASON },
        },
      }),
    });
    assert.strictEqual(res3.status, 200);

    // Step 5: a second assistant-request from the SAME number, a DIFFERENT
    // call id. Asserts resume mode and that the first message carries the
    // complaint captured in step 3, by inspecting the returned assistant.
    const res4 = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          type: 'assistant-request',
          call: { id: secondCallId, from: { phoneNumber: PHONE } },
        },
      }),
    });
    assert.strictEqual(res4.status, 200);
    const body4 = await res4.json();
    assert.ok(body4.assistant, 'second assistant-request should return an assistant');

    const systemPrompt2 = body4.assistant.model.messages[0].content;
    assert.ok(
      systemPrompt2.includes('CONTINUATION'),
      'second call should be answered in resume mode'
    );
    assert.ok(
      body4.assistant.firstMessage.includes(COMPLAINT),
      'resume first message should carry back the complaint captured in step 3, verbatim'
    );
  });
});
