'use strict';

const { test, describe, before, after } = require('node:test');
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

/**
 * Vapi's real server message for a tool invocation is 'tool-calls' (plural),
 * not the singular 'tool-call' this codebase's webhook switch used to
 * listen for exclusively — every real tool call fell into the
 * webhook_unknown_type default branch and was never dispatched (see
 * .superpowers/sdd/audit-vapi.md §4). This file covers the fix: the
 * plural event name, both plausible request-body shapes for the call list
 * (toolCalls / toolCallList), multiple calls in one message, and the
 * documented { results: [{ toolCallId, result }] } response envelope.
 */

// vapiSecretAuth (auth.js) now guards /webhook unconditionally.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-tool-calls-')),
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

describe('webhook tool-calls (plural) dispatch and response envelope', () => {
  let server;
  let baseUrl;
  let repository;

  before(async () => {
    repository = freshRepo();
    const engine = new ConversationEngine({
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

  async function postWebhook(message) {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
      body: JSON.stringify({ message }),
    });
    return { res, body: await res.json() };
  }

  test('a `toolCalls` array is dispatched and each call gets a matching toolCallId in the response', async () => {
    await repository.createSession({ sessionId: 'call-tc-1', patientId: null });

    const { res, body } = await postWebhook({
      type: 'tool-calls',
      call: { id: 'call-tc-1' },
      toolCalls: [
        {
          id: 'toolcall-abc',
          function: { name: 'capture_field', arguments: { field: 'onset', value: 'कल' } },
        },
      ],
    });

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body.results));
    assert.strictEqual(body.results.length, 1);
    assert.strictEqual(body.results[0].toolCallId, 'toolcall-abc');
    assert.strictEqual(body.results[0].result, 'ok');

    const fields = await repository.getSessionFields('call-tc-1');
    assert.strictEqual(fields.onset, 'कल');
  });

  test('a `toolCallList` array (the alternate plausible shape) is also read', async () => {
    await repository.createSession({ sessionId: 'call-tc-2', patientId: null });

    const { res, body } = await postWebhook({
      type: 'tool-calls',
      call: { id: 'call-tc-2' },
      toolCallList: [
        {
          id: 'toolcall-xyz',
          function: { name: 'capture_field', arguments: { field: 'chief_complaint', value: 'बुखार' } },
        },
      ],
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.results[0].toolCallId, 'toolcall-xyz');

    const fields = await repository.getSessionFields('call-tc-2');
    assert.strictEqual(fields.chief_complaint, 'बुखार');
  });

  test('multiple tool calls in one message each get their own result entry, same order', async () => {
    await repository.createSession({ sessionId: 'call-tc-3', patientId: null });

    const { body } = await postWebhook({
      type: 'tool-calls',
      call: { id: 'call-tc-3' },
      toolCalls: [
        { id: 'call-1', function: { name: 'capture_field', arguments: { field: 'onset', value: 'आज' } } },
        { id: 'call-2', function: { name: 'capture_field', arguments: { field: 'breathing', value: 'ठीक है' } } },
      ],
    });

    assert.strictEqual(body.results.length, 2);
    assert.strictEqual(body.results[0].toolCallId, 'call-1');
    assert.strictEqual(body.results[1].toolCallId, 'call-2');

    const fields = await repository.getSessionFields('call-tc-3');
    assert.strictEqual(fields.onset, 'आज');
    assert.strictEqual(fields.breathing, 'ठीक है');
  });

  test('function.arguments as a JSON string is parsed before capture_field runs', async () => {
    await repository.createSession({ sessionId: 'call-tc-4', patientId: null });

    await postWebhook({
      type: 'tool-calls',
      call: { id: 'call-tc-4' },
      toolCalls: [
        {
          id: 'toolcall-str-args',
          function: { name: 'capture_field', arguments: JSON.stringify({ field: 'onset', value: 'परसों' }) },
        },
      ],
    });

    const fields = await repository.getSessionFields('call-tc-4');
    assert.strictEqual(fields.onset, 'परसों');
  });

  test('the legacy singular tool-call event still dispatches and returns the same envelope', async () => {
    await repository.createSession({ sessionId: 'call-tc-5', patientId: null });

    const { res, body } = await postWebhook({
      type: 'tool-call',
      call: { id: 'call-tc-5' },
      tool: { name: 'capture_field', arguments: { field: 'onset', value: 'अभी' } },
    });

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body.results));
    assert.strictEqual(body.results[0].result, 'ok');

    const fields = await repository.getSessionFields('call-tc-5');
    assert.strictEqual(fields.onset, 'अभी');
  });

  test('neither toolCalls, toolCallList, nor tool present: no calls dispatched, empty results, no throw', async () => {
    const { res, body } = await postWebhook({
      type: 'tool-calls',
      call: { id: 'call-tc-6' },
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.results, []);
  });
});
