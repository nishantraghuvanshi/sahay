'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { loadProvidersConfig } = require('../src/core/config/loader');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConversationEngine = require('../src/core/engine/engine');
const PluginRegistry = require('../src/core/plugins/registry');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * M1 — a call.id-less assistant-request must not mint a session.
 *
 * `inbound-${Date.now()}` used to stand in for a missing call.id, opening a
 * session end-of-call-report can never match (that webhook keys off the
 * real call.id). The orphaned row was never resumable and never cleaned up.
 * Skipping session creation is strictly better than a session nothing can
 * close.
 */

// vapiSecretAuth (auth.js) now guards /webhook unconditionally.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-inbound-session-open-')),
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

const PHONE = '+919876500042';

describe('assistant-request with no call.id', () => {
  let repository;
  let server;
  let baseUrl;

  before(async () => {
    repository = freshRepo();
    await repository.upsertPatient({ phone: PHONE, name: 'Meena-ji', drugName: 'Metformin', language: 'hi' });

    const strategy = new MedicationAdherenceStrategy('hi');
    const engine = new ConversationEngine({
      strategy,
      plugins: new PluginRegistry(),
      repository,
    });
    // isBridged is exercised by native-routing.test.js — this test only
    // cares about the /webhook assistant-request path, so stub it "all
    // bridged" to preserve today's route registration.
    const transport = new VapiTransportAdapter({ isBridged: () => true });

    const app = express();
    app.use(express.json());

    await transport.start(null, engine, {
      wss: { on() {} },
      app,
      providersConfig: loadProvidersConfig(),
      strategy,
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

  test('answers the call but opens no session', async () => {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
      body: JSON.stringify({
        message: {
          type: 'assistant-request',
          call: { from: { phoneNumber: PHONE } }, // no id
        },
      }),
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.assistant, 'the caller must still be answered');

    const sessions = await repository.listSessions();
    assert.strictEqual(sessions.length, 0, 'no session should have been created without a call.id');
  });
});
