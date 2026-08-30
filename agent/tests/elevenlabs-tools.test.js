'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const ElevenLabsTransportAdapter = require('../src/adapters/transport/elevenlabs');
const { EVENT_TYPES } = require('../src/core/events/types');

const TEST_SECRET = 'test-secret';
process.env.ELEVENLABS_WEBHOOK_SECRET = TEST_SECRET;

function harness(extraConfig = {}) {
  const app = express();
  app.use(express.json());
  const seen = [];
  const engine = { getEventBus: () => ({ emit: (name, payload) => seen.push({ name, payload }) }) };
  const adapter = new ElevenLabsTransportAdapter({});
  adapter.start(null, engine, { app, webhookUrl: 'https://x', strategy: {}, ...extraConfig });
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
  test('report_outcome reaches the engine on the real tool.called channel', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine',
    }, AUTH_HEADERS);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    // 'tool:report_outcome' was an invented channel nothing subscribed to —
    // the engine only ever listens on EVENT_TYPES.TOOL_CALLED ('tool.called').
    assert.strictEqual(seen[0].name, EVENT_TYPES.TOOL_CALLED);
    assert.strictEqual(seen[0].payload.tool, 'report_outcome');
    assert.strictEqual(seen[0].payload.args.outcome, 'CONFIRMED');
  });

  test('kinvox_call_id in the body becomes callId, not part of args', async () => {
    const { app, seen } = harness();
    await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine', kinvox_call_id: 'call-123',
    }, AUTH_HEADERS);
    assert.strictEqual(seen[0].payload.callId, 'call-123');
    assert.strictEqual(seen[0].payload.args.kinvox_call_id, undefined);
  });

  test('a tool call with no kinvox_call_id gets a null callId, not a throw', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/tools/report_outcome', {
      outcome: 'CONFIRMED', reason: 'user confirmed taking medicine',
    }, AUTH_HEADERS);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen[0].payload.callId, null);
  });

  test('capture_field passes the caller words through untouched', async () => {
    const { app, seen } = harness();
    await post(app, '/el/tools/capture_field', {
      field: 'chief_complaint', value: 'seene mein bhaaripan hai',
    }, AUTH_HEADERS);
    // Verbatim is a safety property, not a nicety: paraphrase loses evidence.
    assert.strictEqual(seen[0].payload.args.value, 'seene mein bhaaripan hai');
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

describe('ElevenLabs post-call webhook', () => {
  // Payload shape verified against the cached OpenAPI spec
  // (GetConversationResponseModel / ConversationHistoryMetadataCommonModel /
  // ConversationHistoryAnalysisCommonModel) rather than guessed. tool_calls
  // nest per transcript turn in the real spec — not a flat list the way
  // Vapi's end-of-call-report carries them.
  const FULL_PAYLOAD = {
    conversation_id: 'conv_1',
    transcript: [
      { role: 'agent', message: 'Namaste, kya aapne dawai le li?' },
      {
        role: 'agent',
        message: '',
        tool_calls: [{ tool_name: 'report_outcome', params_as_json: '{"outcome":"CONFIRMED","reason":"user confirmed"}' }],
      },
      { role: 'user', message: 'Haan, le li' },
    ],
    metadata: {
      call_duration_secs: 42,
      cost: 0.031,
      termination_reason: 'agent_ended_call',
      phone_call: { external_number: '+919000000042' },
    },
    conversation_initiation_client_data: {
      dynamic_variables: { patient_name: 'Kamala', kinvox_call_id: 'call-1' },
    },
    analysis: { call_successful: 'success' },
  };

  test('emits CONVERSATION_ENDED with the mapped call data — this is the actual bug: writing a row without this skips the whole engine', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/post-call', FULL_PAYLOAD, AUTH_HEADERS);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].name, EVENT_TYPES.CONVERSATION_ENDED);

    const { callData } = seen[0].payload;
    assert.strictEqual(callData.callId, 'conv_1');
    assert.strictEqual(callData.phone, '+919000000042');
    assert.strictEqual(callData.duration, 42);
    assert.strictEqual(callData.cost, 0.031);
    assert.strictEqual(callData.endedReason, 'agent_ended_call');
    assert.deepStrictEqual(callData.variables, { patient_name: 'Kamala', kinvox_call_id: 'call-1' });
    assert.strictEqual(callData.recordingUrl, null);
    assert.deepStrictEqual(callData.toolCalls, [
      { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED","reason":"user confirmed"}' },
    ]);
    assert.match(callData.transcript, /agent: Namaste, kya aapne dawai le li\?/);
    assert.match(callData.transcript, /user: Haan, le li/);
  });

  test('a payload with no conversation_id is refused, not written half-formed', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/post-call', { transcript: [] }, AUTH_HEADERS);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(seen.length, 0);
  });

  test('a request with no token is refused and never reaches the event bus', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/post-call', FULL_PAYLOAD);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(seen.length, 0);
  });

  test('a request with the wrong token is refused and never reaches the event bus', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/post-call', FULL_PAYLOAD, { 'X-Kinvox-Token': 'not-the-secret' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(seen.length, 0);
  });
});
