'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const PlaygroundTransportAdapter = require('../src/adapters/transport/playground');
const { openCall, recordTurn } = require('../src/core/call/lifecycle');
const { loadProvidersConfig } = require('../src/core/config/loader');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * Task 2 — turn history actually gets written.
 *
 * `messages` had a working saveMessage()/getMessages() pair that nothing in
 * production called, so the table was always empty. recordTurn() (in
 * src/core/call/lifecycle.js) is the shared write both transports now call.
 *
 * It also turned out messages.call_id is a foreign key against calls, and
 * nothing created that row until end-of-call — so a mid-call insert would
 * have failed its FK constraint every time. openCall() now ensures a calls
 * row exists up front; the "openCall — ensures a calls row exists" block
 * below covers that directly.
 */

// vapiSecretAuth (auth.js) now guards /webhook unconditionally.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-turn-history-')),
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

describe('recordTurn (lifecycle)', () => {
  test('a turn with no call id is tolerated, not thrown', async () => {
    const repo = freshRepo();
    await assert.doesNotReject(
      recordTurn({ repository: repo, callId: null, role: 'user', content: 'hi' })
    );
    await repo.close();
  });

  test('a turn against an unknown call is tolerated, not thrown', async () => {
    const repo = freshRepo();
    // No calls row exists for 'ghost-call' and none is created here — the
    // FK constraint on messages.call_id must be caught, not thrown.
    await assert.doesNotReject(
      recordTurn({ repository: repo, callId: 'ghost-call', role: 'user', content: 'hi' })
    );
    const messages = await repo.getMessages('ghost-call');
    assert.strictEqual(messages.length, 0);
    await repo.close();
  });

  test('turns persist and read back in order, including tool calls', async () => {
    const repo = freshRepo();
    await openCall({ repository: repo, phone: '+919876500011', direction: 'outbound', callId: 'turn-order' });

    await recordTurn({ repository: repo, callId: 'turn-order', role: 'user', content: 'first' });
    await recordTurn({ repository: repo, callId: 'turn-order', role: 'assistant', content: 'second' });
    await recordTurn({
      repository: repo,
      callId: 'turn-order',
      role: 'assistant',
      toolCalls: [{ name: 'capture_field', arguments: { field: 'chief_complaint', value: 'बुखार' } }],
    });

    const messages = await repo.getMessages('turn-order');
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].content, 'first');
    assert.strictEqual(messages[1].content, 'second');
    assert.strictEqual(JSON.parse(messages[2].tool_calls)[0].name, 'capture_field');
  });
});

describe('openCall — ensures a calls row exists', () => {
  test('a call row is created so mid-call messages do not violate the FK constraint', async () => {
    const repo = freshRepo();
    await openCall({ repository: repo, phone: '+919876500012', direction: 'inbound', callId: 'auto-row' });

    const call = await repo.getCall('auto-row');
    assert.ok(call, 'openCall should have created a calls row for this call id');

    await assert.doesNotReject(
      recordTurn({ repository: repo, callId: 'auto-row', role: 'user', content: 'hello' })
    );
    const messages = await repo.getMessages('auto-row');
    assert.strictEqual(messages.length, 1);
  });

  test('is idempotent — a retried assistant-request for the same call id does not throw', async () => {
    const repo = freshRepo();
    await openCall({ repository: repo, phone: '+919876500013', direction: 'inbound', callId: 'retry-row' });
    await assert.doesNotReject(
      openCall({ repository: repo, phone: '+919876500013', direction: 'inbound', callId: 'retry-row' })
    );
  });
});

describe('webhook — transcript and tool-call events write turn history', () => {
  let repository;
  let server;
  let baseUrl;

  async function setup() {
    repository = freshRepo();
    const strategy = new MedicationAdherenceStrategy('hi');
    const transport = new VapiTransportAdapter({ isBridged: () => true });
    const app = express();
    app.use(express.json());
    await transport.start(null, { getEventBus: () => ({ emit: async () => {} }) }, {
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

  test('a final transcript persists as a turn; a partial one does not', async () => {
    await setup();
    try {
      await repository.createCall({ callId: 'transcript-call' });

      await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: {
            type: 'transcript',
            call: { id: 'transcript-call' },
            role: 'user',
            transcript: 'partial text',
            transcriptType: 'partial',
          },
        }),
      });
      await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: {
            type: 'transcript',
            call: { id: 'transcript-call' },
            role: 'user',
            transcript: 'final text',
            transcriptType: 'final',
          },
        }),
      });

      const messages = await repository.getMessages('transcript-call');
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].content, 'final text');
    } finally {
      await teardown();
    }
  });

  test('a tool-call event persists an assistant turn carrying the tool call', async () => {
    await setup();
    try {
      await repository.createCall({ callId: 'toolcall-call' });

      await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: {
            type: 'tool-call',
            call: { id: 'toolcall-call' },
            tool: { name: 'capture_field', arguments: { field: 'onset', value: 'आज' } },
          },
        }),
      });

      const messages = await repository.getMessages('toolcall-call');
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].role, 'assistant');
      const toolCalls = JSON.parse(messages[0].tool_calls);
      assert.strictEqual(toolCalls[0].name, 'capture_field');
    } finally {
      await teardown();
    }
  });

  test('a transcript with no call id is tolerated, not thrown', async () => {
    await setup();
    try {
      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({
          message: { type: 'transcript', role: 'user', transcript: 'no call here', transcriptType: 'final' },
        }),
      });
      assert.strictEqual(res.status, 200);
    } finally {
      await teardown();
    }
  });
});

describe('PlaygroundTransportAdapter.recordTurn', () => {
  test('routes a turn through the shared lifecycle module', async () => {
    const repo = freshRepo();
    await repo.upsertPatient({ phone: '+919876500014', name: 'Kiran-ji', drugName: 'Amlodipine', language: 'hi' });
    const transport = new PlaygroundTransportAdapter({});
    await transport.start(null, null, { repository: repo, strategy: {} });

    const { sessionId } = await transport.openSession({ phone: '+919876500014', direction: 'outbound' });
    await transport.recordTurn({ sessionId, role: 'user', content: 'नमस्ते' });
    await transport.recordTurn({ sessionId, role: 'assistant', content: 'हैलो', toolCalls: null });

    const messages = await repo.getMessages(sessionId);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[1].role, 'assistant');
  });
});
