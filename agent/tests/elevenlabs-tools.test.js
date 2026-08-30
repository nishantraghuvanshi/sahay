'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const ElevenLabsTransportAdapter = require('../src/adapters/transport/elevenlabs');

const TEST_SECRET = 'test-secret';
process.env.ELEVENLABS_WEBHOOK_SECRET = TEST_SECRET;

function harness() {
  const app = express();
  app.use(express.json());
  const seen = [];
  const engine = { getEventBus: () => ({ emit: (name, payload) => seen.push({ name, payload }) }) };
  const adapter = new ElevenLabsTransportAdapter({});
  adapter.start(null, engine, { app, webhookUrl: 'https://x', strategy: {} });
  return { app, seen };
}

async function post(app, path, body, headers = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const AUTH_HEADERS = { 'X-Kinvox-Token': TEST_SECRET };

describe('ElevenLabs tool webhooks', () => {
  test('report_outcome reaches the engine', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine',
    }, AUTH_HEADERS);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(seen[0].name, 'tool:report_outcome');
    assert.strictEqual(seen[0].payload.outcome, 'CONFIRMED');
  });

  test('capture_field passes the caller words through untouched', async () => {
    const { app, seen } = harness();
    await post(app, '/el/tools/capture_field', {
      field: 'chief_complaint', value: 'seene mein bhaaripan hai',
    }, AUTH_HEADERS);
    // Verbatim is a safety property, not a nicety: paraphrase loses evidence.
    assert.strictEqual(seen[0].payload.value, 'seene mein bhaaripan hai');
  });

  test('an unknown tool is refused, not silently accepted', async () => {
    const { app } = harness();
    const res = await post(app, '/el/tools/drop_database', { x: 1 }, AUTH_HEADERS);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.ok, false);
  });

  test('a request with no token is refused and never reaches the event bus', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine',
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(seen.length, 0);
  });

  test('a request with the wrong token is refused and never reaches the event bus', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine',
    }, { 'X-Kinvox-Token': 'not-the-secret' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(seen.length, 0);
  });
});
