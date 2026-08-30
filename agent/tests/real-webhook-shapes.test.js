'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConversationEngine = require('../src/core/engine/engine');
const PluginRegistry = require('../src/core/plugins/registry');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const { EVENT_TYPES } = require('../src/core/events/types');

/**
 * An audit of two real phone calls (see .superpowers/audit-2026-08-30 and
 * tests/fixtures/vapi-real/README.md) found Vapi never sends 'call-started'
 * or 'transcript' on the phone path — it sends 'status-update',
 * 'speech-update', 'assistant.started' and 'end-of-call-report'. The first
 * three of those fell into the webhook's `default:` branch and were
 * silently discarded behind a 200 OK. These tests drive the real, sanitized
 * payloads through the actual /webhook route (same harness as
 * tests/tool-calls-webhook.test.js) and assert none of them are discarded.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'vapi-real');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

// vapiSecretAuth (auth.js) now guards /webhook unconditionally.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-real-webhook-')),
    'test.db'
  );
  tmpDbs.push(dbPath);
  return new SqliteRepository({ dbPath });
}

after(() => {
  for (const p of tmpDbs) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe('real Vapi payload shapes are not silently discarded', () => {
  let server;
  let baseUrl;
  let repository;
  let engine;
  let logLines;
  let restoreConsole;

  before(async () => {
    repository = freshRepo();
    engine = new ConversationEngine({
      strategy: {},
      plugins: new PluginRegistry(),
      repository,
    });
    const transport = new VapiTransportAdapter({ isBridged: () => true });

    const app = express();
    app.use(express.json());

    await transport.start(null, engine, {
      wss: { on() {} },
      app,
      providersConfig: {},
      strategy: {},
      repository,
      webhookUrl: 'http://localhost',
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Every case that reaches the switch's `default:` logs a
  // 'webhook_unknown_type' JSON line via console.log. Capture stdout for
  // the duration of one request instead of inventing a new logger seam.
  beforeEach(() => {
    logLines = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logLines.push(args[0]);
      // Keep test output legible without hiding real failures' console noise.
      originalLog(...args);
    };
    restoreConsole = () => { console.log = originalLog; };
  });

  function parsedLogEvents() {
    return logLines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  async function postWebhook(message) {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
      body: JSON.stringify({ message }),
    });
    const body = await res.json();
    restoreConsole();
    return { res, body, events: parsedLogEvents() };
  }

  test('status-update / in-progress emits CONVERSATION_STARTED — the replacement for the dead call-started path', async () => {
    const fixture = loadFixture('status-update-in-progress');

    let received = null;
    const handler = (event) => { received = event; };
    engine.getEventBus().on(EVENT_TYPES.CONVERSATION_STARTED, handler);

    const { res, events } = await postWebhook(fixture.message);

    assert.strictEqual(res.status, 200);
    assert.ok(received, 'CONVERSATION_STARTED should have fired');
    assert.strictEqual(received.payload.callId, fixture.message.call.id);
    assert.strictEqual(received.payload.phone, fixture.message.call.customer.number);
    assert.ok(
      !events.some((e) => e.event === 'webhook_unknown_type'),
      'a real status-update must not fall through to the unknown-type branch'
    );
  });

  test('status-update / ended is recognised and its endedReason is read, not routed to the unknown-type branch', async () => {
    const fixture = loadFixture('status-update-ended');

    const { res, events } = await postWebhook(fixture.message);

    assert.strictEqual(res.status, 200);
    assert.ok(
      !events.some((e) => e.event === 'webhook_unknown_type'),
      'a real status-update(ended) must not fall through to the unknown-type branch'
    );
    const endedEvent = events.find((e) => e.endedReason !== undefined);
    assert.ok(endedEvent, 'the handler should have read and logged endedReason');
    assert.strictEqual(endedEvent.endedReason, fixture.message.endedReason);
  });

  test('speech-update is recognised as a known type', async () => {
    const fixture = loadFixture('speech-update');

    const { res, events } = await postWebhook(fixture.message);

    assert.strictEqual(res.status, 200);
    assert.ok(
      !events.some((e) => e.event === 'webhook_unknown_type'),
      'a real speech-update must not fall through to the unknown-type branch'
    );
  });

  test('assistant.started is recognised as a known type', async () => {
    const fixture = loadFixture('assistant-started');

    const { res, events } = await postWebhook(fixture.message);

    assert.strictEqual(res.status, 200);
    assert.ok(
      !events.some((e) => e.event === 'webhook_unknown_type'),
      'a real assistant.started must not fall through to the unknown-type branch'
    );
  });

  test('end-of-call-report still works (regression guard)', async () => {
    const fixture = loadFixture('end-of-call-report');

    const { res, events } = await postWebhook(fixture.message);

    assert.strictEqual(res.status, 200);
    assert.ok(
      !events.some((e) => e.event === 'webhook_unknown_type'),
      'end-of-call-report must not fall through to the unknown-type branch'
    );
  });
});
