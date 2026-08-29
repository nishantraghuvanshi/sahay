'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { TOOLS } = require('../src/use-cases/medication-adherence/tools');
const { INTAKE_FIELDS } = require('../src/use-cases/medication-adherence/inbound-context');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConversationEngine = require('../src/core/engine/engine');
const PluginRegistry = require('../src/core/plugins/registry');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');

/**
 * capture_field is the tool that lets the agent record what it learns
 * turn-by-turn, instead of only at end-of-call via report_outcome. These
 * tests cover both the tool's shape (enum-bound to INTAKE_FIELDS so the two
 * cannot desync) and the webhook wiring that writes a captured field into
 * fields_so_far.
 */

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-capture-field-')),
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

describe('capture_field tool definition', () => {
  const tool = TOOLS.find((t) => t.function.name === 'capture_field');

  test('is present in TOOLS with both required parameters', () => {
    assert.ok(tool, 'capture_field should be in TOOLS');
    assert.strictEqual(tool.type, 'function');
    assert.deepStrictEqual(tool.function.parameters.required, ['field', 'value']);
    assert.ok(tool.function.parameters.properties.field);
    assert.ok(tool.function.parameters.properties.value);
  });

  test('is async, unlike report_outcome — it fires every turn, not once at call end', () => {
    // A blocking capture_field pays a round trip on every turn for a tool
    // that hands the model nothing back; report_outcome fires once and gets
    // away with blocking.
    assert.strictEqual(tool.async, true);
    const reportOutcome = TOOLS.find((t) => t.function.name === 'report_outcome');
    assert.strictEqual(reportOutcome.async, false, 'report_outcome must stay blocking');
  });

  test('field enum exactly equals the INTAKE_FIELDS keys', () => {
    assert.deepStrictEqual(
      tool.function.parameters.properties.field.enum,
      INTAKE_FIELDS.map((f) => f.key)
    );
  });

  test('description mentions verbatim capture and forbids batching', () => {
    assert.match(tool.function.description, /VERBATIM/);
    assert.match(tool.function.description, /never batch/i);
  });
});

describe('webhook tool-call handling for capture_field', () => {
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
    const transport = new VapiTransportAdapter({});

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

  /** POST a Vapi tool-call webhook message for capture_field. */
  async function postCapture(callId, field, value) {
    return fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          type: 'tool-call',
          call: { id: callId },
          tool: { name: 'capture_field', arguments: { field, value } },
        },
      }),
    });
  }

  test('writing a known field to a live session merges into fields_so_far', async () => {
    await repository.createSession({ sessionId: 'call-1', patientId: null });

    const res = await postCapture('call-1', 'onset', 'तीन दिन से');
    assert.strictEqual(res.status, 200);

    const fields = await repository.getSessionFields('call-1');
    assert.strictEqual(fields.onset, 'तीन दिन से');
  });

  test('writing an unknown field name leaves fields_so_far unchanged', async () => {
    await repository.createSession({ sessionId: 'call-2', patientId: null });

    const res = await postCapture('call-2', 'favourite_colour', 'blue');
    assert.strictEqual(res.status, 200);

    const fields = await repository.getSessionFields('call-2');
    assert.deepStrictEqual(fields, {});
  });

  test('two successive captures of different fields both survive', async () => {
    await repository.createSession({ sessionId: 'call-3', patientId: null });

    await postCapture('call-3', 'chief_complaint', 'बुखार');
    await postCapture('call-3', 'onset', 'कल रात से');

    const fields = await repository.getSessionFields('call-3');
    assert.strictEqual(fields.chief_complaint, 'बुखार');
    assert.strictEqual(fields.onset, 'कल रात से');
  });

  test('an unknown session is logged and does not throw out of the webhook', async () => {
    const res = await postCapture('no-such-call', 'onset', 'today');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
  });
});
