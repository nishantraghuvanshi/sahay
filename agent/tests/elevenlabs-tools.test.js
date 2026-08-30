'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');

const ElevenLabsTransportAdapter = require('../src/adapters/transport/elevenlabs');
const { captureRawBody } = require('../src/adapters/transport/elevenlabs-signature');
const { EVENT_TYPES } = require('../src/core/events/types');

const TEST_SECRET = 'test-secret';
process.env.ELEVENLABS_WEBHOOK_SECRET = TEST_SECRET;

function harness(extraConfig = {}) {
  const app = express();
  // The same hook server.js installs. Without it req.rawBody is undefined and
  // signature verification cannot run at all.
  app.use(express.json({ verify: captureRawBody }));
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

describe('ElevenLabs post-call webhook — the shape the service actually sends', () => {
  // The tests above this one describe a BARE payload: conversation_id,
  // transcript and metadata at the top level. That is the shape of
  // GET /v1/convai/conversations/{id} (GetConversationResponseModel), and it
  // is what the plan assumed the webhook would post.
  //
  // It is not. The webhook wraps that object in an envelope:
  //
  //   { "type": "post_call_transcription",
  //     "event_timestamp": 1739537297,
  //     "data": { conversation_id, transcript, metadata, analysis } }
  //
  // Confirmed against ElevenLabs' post-call webhook documentation. Reading
  // body.conversation_id off a real delivery yields undefined, so the route
  // answered 400 "conversation_id required" and nothing was ever persisted —
  // the fifth contract on this branch that was inferred and wrong. Both
  // shapes are accepted now, because the bare one is genuinely returned by
  // the GET endpoint and the same mapper serves both.
  const DATA = {
    conversation_id: 'conv_enveloped',
    transcript: [
      { role: 'agent', message: 'Namaste, kya aapne dawai le li?' },
      {
        role: 'agent',
        message: '',
        tool_calls: [
          {
            tool_name: 'report_outcome',
            params_as_json: '{"outcome":"CONFIRMED","reason":"user confirmed"}',
          },
        ],
      },
      { role: 'user', message: 'Haan, le li' },
    ],
    metadata: {
      call_duration_secs: 61,
      cost: 0.044,
      termination_reason: 'agent_ended_call',
      phone_call: { external_number: '+919000000042' },
    },
    conversation_initiation_client_data: {
      dynamic_variables: { parent_name: 'Kamala', kinvox_call_id: 'call-9' },
    },
    analysis: { call_successful: 'success' },
  };

  const ENVELOPED = {
    type: 'post_call_transcription',
    event_timestamp: 1_756_500_000,
    data: DATA,
  };

  test('unwraps the data envelope and emits CONVERSATION_ENDED', async () => {
    const { app, seen } = harness();
    const res = await post(app, '/el/post-call', ENVELOPED, AUTH_HEADERS);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].name, EVENT_TYPES.CONVERSATION_ENDED);

    const { callData } = seen[0].payload;
    assert.strictEqual(callData.callId, 'conv_enveloped');
    assert.strictEqual(callData.duration, 61);
    assert.strictEqual(callData.cost, 0.044);
    assert.strictEqual(callData.phone, '+919000000042');
    assert.deepStrictEqual(callData.toolCalls, [
      { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED","reason":"user confirmed"}' },
    ]);
    assert.match(callData.transcript, /user: Haan, le li/);
  });

  test('a non-transcript event type is acknowledged, not processed', async () => {
    // post_call_audio carries no transcript. Answering 400 would make
    // ElevenLabs retry a delivery that will never succeed; answering 200
    // without emitting keeps the retry queue clean and the engine untouched.
    const { app, seen } = harness();
    const res = await post(
      app,
      '/el/post-call',
      { type: 'post_call_audio', event_timestamp: 1, data: { conversation_id: 'conv_audio' } },
      AUTH_HEADERS
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ignored, 'post_call_audio');
    assert.strictEqual(seen.length, 0);
  });

  test('an enveloped payload with no conversation_id is still refused', async () => {
    const { app, seen } = harness();
    const res = await post(
      app,
      '/el/post-call',
      { type: 'post_call_transcription', data: { transcript: [] } },
      AUTH_HEADERS
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(seen.length, 0);
  });
});

describe('ElevenLabs post-call webhook — HMAC signature authentication', () => {
  const SIGNING_SECRET = 'wsec_route_test_secret';

  function signedHeaders(body, { secret = SIGNING_SECRET, timestamp = null } = {}) {
    const t = timestamp === null ? Math.floor(Date.now() / 1000) : timestamp;
    const digest = crypto
      .createHmac('sha256', secret)
      .update(`${t}.${JSON.stringify(body)}`)
      .digest('hex');
    return { 'ElevenLabs-Signature': `t=${t},v0=${digest}` };
  }

  const PAYLOAD = {
    type: 'post_call_transcription',
    event_timestamp: 1,
    data: { conversation_id: 'conv_signed', transcript: [], metadata: {} },
  };

  function withSigningSecret(fn) {
    // Set and restore rather than leak: describes in this file run in
    // declaration order in one process, and the tests above assert the
    // token path still works with no signing secret configured.
    const previous = process.env.ELEVENLABS_POST_CALL_SECRET;
    process.env.ELEVENLABS_POST_CALL_SECRET = SIGNING_SECRET;
    return (async () => {
      try {
        return await fn();
      } finally {
        if (previous === undefined) delete process.env.ELEVENLABS_POST_CALL_SECRET;
        else process.env.ELEVENLABS_POST_CALL_SECRET = previous;
      }
    })();
  }

  test('a correctly signed delivery is accepted without any X-Kinvox-Token', () =>
    withSigningSecret(async () => {
      const { app, seen } = harness();
      const res = await post(app, '/el/post-call', PAYLOAD, signedHeaders(PAYLOAD));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].payload.callData.callId, 'conv_signed');
    }));

  test('a delivery signed with the wrong secret is refused', () =>
    withSigningSecret(async () => {
      const { app, seen } = harness();
      const res = await post(
        app,
        '/el/post-call',
        PAYLOAD,
        signedHeaders(PAYLOAD, { secret: 'wsec_not_ours' })
      );
      assert.strictEqual(res.status, 401);
      assert.strictEqual(seen.length, 0);
    }));

  test('a replayed delivery outside the tolerance window is refused', () =>
    withSigningSecret(async () => {
      const { app, seen } = harness();
      const stale = Math.floor(Date.now() / 1000) - 4000;
      const res = await post(app, '/el/post-call', PAYLOAD, signedHeaders(PAYLOAD, { timestamp: stale }));
      assert.strictEqual(res.status, 401);
      assert.strictEqual(seen.length, 0);
    }));

  test('the X-Kinvox-Token path still works while a signing secret is configured', () =>
    // Both mechanisms are accepted: ElevenLabs always signs, but a webhook
    // configured in the dashboard with a custom header should not break.
    withSigningSecret(async () => {
      const { app, seen } = harness();
      const res = await post(app, '/el/post-call', PAYLOAD, AUTH_HEADERS);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(seen.length, 1);
    }));

  test('an unsigned, untokened delivery is refused even with both secrets set', () =>
    withSigningSecret(async () => {
      const { app, seen } = harness();
      const res = await post(app, '/el/post-call', PAYLOAD);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(seen.length, 0);
    }));
});
