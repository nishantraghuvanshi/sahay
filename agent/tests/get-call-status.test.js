'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const ElevenLabsTransportAdapter = require('../src/adapters/transport/elevenlabs');
const PlaygroundTransportAdapter = require('../src/adapters/transport/playground');

/**
 * Task 2 — TransportPort#getCallStatus, exercised directly against each
 * adapter. GET /api/call/:callId used to fetch api.vapi.ai directly and
 * hardcode VAPI_PRIVATE_KEY; these tests cover the replacement per adapter,
 * separately from call-status-route.test.js which covers the route
 * delegation through a booted server.
 */

describe('VapiTransportAdapter#getCallStatus', () => {
  let originalFetch;
  let originalApiKey;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalApiKey = process.env.VAPI_PRIVATE_KEY;
  });

  after(() => {
    global.fetch = originalFetch;
    process.env.VAPI_PRIVATE_KEY = originalApiKey;
  });

  test('returns ok:false without a network call when VAPI_PRIVATE_KEY is unset', async () => {
    delete process.env.VAPI_PRIVATE_KEY;
    global.fetch = async () => {
      throw new Error('must not call fetch without a key');
    };
    const adapter = new VapiTransportAdapter(null);
    const result = await adapter.getCallStatus('call-1');
    assert.deepStrictEqual(result, { ok: false, error: 'VAPI_PRIVATE_KEY not set', httpStatus: 500 });
  });

  test('maps a successful Vapi response to the { ok: true, ... } shape', async () => {
    process.env.VAPI_PRIVATE_KEY = 'test-key';
    global.fetch = async (url, opts) => {
      assert.strictEqual(url, 'https://api.vapi.ai/call/call-1');
      assert.strictEqual(opts.headers.Authorization, 'Bearer test-key');
      return {
        ok: true,
        json: async () => ({
          id: 'call-1',
          status: 'ended',
          durationSeconds: 42,
          cost: 0.12,
          analysis: { structuredData: { outcome: 'CONFIRMED' } },
          transcript: 'hello',
        }),
      };
    };
    const adapter = new VapiTransportAdapter(null);
    const result = await adapter.getCallStatus('call-1');
    assert.deepStrictEqual(result, {
      ok: true,
      callId: 'call-1',
      status: 'ended',
      duration: 42,
      cost: 0.12,
      outcome: 'CONFIRMED',
      transcript: 'hello',
    });
  });

  test('surfaces a Vapi error response with its own status', async () => {
    process.env.VAPI_PRIVATE_KEY = 'test-key';
    global.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => 'call not found',
    });
    const adapter = new VapiTransportAdapter(null);
    const result = await adapter.getCallStatus('missing-call');
    assert.deepStrictEqual(result, { ok: false, error: 'call not found', httpStatus: 404 });
  });

  test('a thrown network error is reported, not left to escape as a rejection', async () => {
    process.env.VAPI_PRIVATE_KEY = 'test-key';
    global.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    const adapter = new VapiTransportAdapter(null);
    const result = await adapter.getCallStatus('call-1');
    assert.deepStrictEqual(result, { ok: false, error: 'ECONNRESET', httpStatus: 500 });
  });
});

describe('ElevenLabsTransportAdapter#getCallStatus', () => {
  test('reports unsupported rather than fabricating a status', async () => {
    const adapter = new ElevenLabsTransportAdapter({});
    const result = await adapter.getCallStatus('call-1');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'unsupported');
    assert.strictEqual(result.httpStatus, 501);
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
  });
});

describe('PlaygroundTransportAdapter#getCallStatus', () => {
  test('throws — there is no callId a caller could legitimately hold', async () => {
    const adapter = new PlaygroundTransportAdapter({});
    await assert.rejects(() => adapter.getCallStatus('anything'), /not applicable/);
  });
});
