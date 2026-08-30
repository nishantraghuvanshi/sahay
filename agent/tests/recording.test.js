'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const { loadProvidersConfig } = require('../src/core/config/loader');
const ConversationEngine = require('../src/core/engine/engine');
const PluginRegistry = require('../src/core/plugins/registry');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * Task 1 — call recording.
 *
 * Nothing previously set artifactPlan on the Vapi assistant config, so
 * whether a call was recorded depended on an unverified account default,
 * and end-of-call-report discarded any recording URL it received. These
 * tests cover: recording explicitly enabled, the recording_url column
 * existing on both a fresh and a migrated database, and extraction from
 * end-of-call-report (mono preferred over stereo, null when absent).
 */

// vapiSecretAuth (auth.js) now guards /webhook unconditionally.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-recording-')),
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

describe('recording_url column', () => {
  test('exists on a fresh database', async () => {
    const repo = freshRepo();
    const columns = repo.db.prepare('PRAGMA table_info(calls)').all();
    assert.ok(columns.some((c) => c.name === 'recording_url'));
    await repo.close();
  });

  test('is added to a database migrated from before this change, without throwing', async () => {
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-recording-migration-')),
      'test.db'
    );
    tmpDbs.push(dbPath);

    // Hand-build the pre-recording_url schema, exactly as it looked before
    // this change, then open it through SqliteRepository like a real
    // pre-existing production database would be. TEXT primary key, matching
    // schema.sql — an INTEGER one is a *different*, incompatible case (task
    // 4), not what this test is about.
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE calls (
        id TEXT PRIMARY KEY,
        call_id TEXT UNIQUE NOT NULL,
        outcome_label TEXT,
        ground_truth TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    oldDb.exec(`INSERT INTO calls (call_id, outcome_label) VALUES ('pre-existing-call', 'CONFIRMED')`);
    oldDb.close();

    const repo = new SqliteRepository({ dbPath });
    const columns = repo.db.prepare('PRAGMA table_info(calls)').all();
    assert.ok(columns.some((c) => c.name === 'recording_url'));

    // The pre-existing row survived the migration untouched.
    const call = await repo.getCall('pre-existing-call');
    assert.strictEqual(call.outcome_label, 'CONFIRMED');
    assert.strictEqual(call.recording_url, null);

    await repo.close();
  });
});

describe('buildAssistantConfig — recording', () => {
  test('sets artifactPlan.recordingEnabled explicitly, and no disclosure line is added', () => {
    const registry = { isBridged: () => true, getActiveProviderNames: () => ({}) };
    const transport = new VapiTransportAdapter(registry);
    const strategy = new MedicationAdherenceStrategy('hi');
    const providers = loadProvidersConfig();

    const config = transport.buildAssistantConfig(strategy, providers, 'http://localhost:3001', {
      mode: 'outbound',
      variables: { parent_name: 'Test', drug_name: 'Aspirin' },
    });

    assert.strictEqual(config.artifactPlan.recordingEnabled, true);
    assert.ok(
      !config.model.messages[0].content.includes('recorded'),
      'no disclosure line should have been added to the system prompt'
    );
  });
});

describe('end-of-call-report — recording URL extraction', () => {
  let repository;
  let server;
  let baseUrl;

  async function setup() {
    repository = freshRepo();
    const strategy = new MedicationAdherenceStrategy('hi');
    // A real engine (not a stubbed event bus) — CONVERSATION_ENDED's
    // handler is what actually calls repository.save() with recordingUrl.
    const engine = new ConversationEngine({ strategy, plugins: new PluginRegistry(), repository });
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
  }

  async function teardown() {
    await new Promise((resolve) => server.close(resolve));
  }

  test('persists the plain recording URL when both mono and stereo are present', async () => {
    await setup();
    try {
      await repository.createCall({ callId: 'rec-both' });
      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: {
            type: 'end-of-call-report',
            call: { id: 'rec-both' },
            artifact: {
              recordingUrl: 'https://vapi.example/rec-both-mono.wav',
              stereoRecordingUrl: 'https://vapi.example/rec-both-stereo.wav',
            },
          },
        }),
      });
      assert.strictEqual(res.status, 200);

      const call = await repository.getCall('rec-both');
      assert.strictEqual(call.recording_url, 'https://vapi.example/rec-both-mono.wav');
    } finally {
      await teardown();
    }
  });

  test('falls back to the stereo URL when only that is present', async () => {
    await setup();
    try {
      await repository.createCall({ callId: 'rec-stereo-only' });
      await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: {
            type: 'end-of-call-report',
            call: { id: 'rec-stereo-only' },
            artifact: { stereoRecordingUrl: 'https://vapi.example/stereo-only.wav' },
          },
        }),
      });

      const call = await repository.getCall('rec-stereo-only');
      assert.strictEqual(call.recording_url, 'https://vapi.example/stereo-only.wav');
    } finally {
      await teardown();
    }
  });

  test('stores null and does not throw when no recording URL is present', async () => {
    await setup();
    try {
      await repository.createCall({ callId: 'rec-none' });
      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: { type: 'end-of-call-report', call: { id: 'rec-none' } },
        }),
      });
      assert.strictEqual(res.status, 200);

      const call = await repository.getCall('rec-none');
      assert.strictEqual(call.recording_url, null);
    } finally {
      await teardown();
    }
  });
});
