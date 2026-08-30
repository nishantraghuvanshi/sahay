'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { loadProvidersConfig } = require('../src/core/config/loader');
const ConversationEngine = require('../src/core/engine/engine');
const PluginRegistry = require('../src/core/plugins/registry');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * F8 — the assistant-request failure branch has no test.
 *
 * src/adapters/transport/vapi.js's webhook handler returns { error } (not
 * { status: 'ok' }) when resolving an assistant-request throws, because a
 * caller is on the line waiting and a silent 200 { status: 'ok' } hands
 * Vapi no assistant to answer with — see vapi.js's catch block around the
 * webhook switch. Nothing in tests/ exercised that branch before this file:
 * every other assistant-request test (inbound-session-open,
 * inbound-resolution, resume-e2e, sessions) drives the happy path. This
 * forces resolveInboundCall's own DB call to throw, so a real resolution
 * failure — not a malformed request — is what's under test.
 */

const PHONE = '+919876500043';

// vapiSecretAuth (auth.js) now guards /webhook unconditionally.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

describe('assistant-request when resolution throws', () => {
  let server;
  let baseUrl;

  before(async () => {
    // A repository whose read throws mid-resolution — nothing in
    // resolveInboundCall wraps this call in a try/catch (unlike the
    // best-effort _ensureCallRow), so it propagates all the way up through
    // openCall and _buildInboundAssistant into the webhook handler's catch.
    const repository = {
      findPatientByPhone: async () => {
        throw new Error('db unavailable');
      },
    };

    const strategy = new MedicationAdherenceStrategy('hi');
    const engine = new ConversationEngine({
      strategy,
      plugins: new PluginRegistry(),
      repository,
    });
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

  test('answers with an error, not a silent {status:"ok"}, when resolution fails', async () => {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
      body: JSON.stringify({
        message: {
          type: 'assistant-request',
          call: { from: { phoneNumber: PHONE } },
        },
      }),
    });

    // Still a 200 — Vapi's documented shape for this webhook — but the body
    // must carry the documented `error` field, never {status:'ok'}: a
    // caller is waiting on the other end, and 'ok' with no assistant would
    // hide the failure entirely.
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.error, 'the response must carry an error, not silently answer ok');
    assert.strictEqual(body.assistant, undefined, 'no assistant can be built after a resolution failure');
    assert.notStrictEqual(body.status, 'ok');
  });
});
