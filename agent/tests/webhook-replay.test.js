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
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * Replays two REAL Vapi calls, end to end, in the order Vapi actually
 * delivered them.
 *
 * tests/real-webhook-shapes.test.js proves each message TYPE is handled.
 * That is not the same as proving a whole call survives, because two things
 * only exist in a sequence:
 *
 *  1. Ordering. The two captured calls disagree with each other —
 *     call 1 delivered status-update/in-progress BEFORE assistant.started;
 *     call 2 delivered it AFTER. Vapi does not guarantee inter-type order, so
 *     any handling that assumes "the call starts, then things happen" is
 *     already wrong half the time. A per-type test cannot see this.
 *
 *  2. Terminal state. A call ends via status-update/ended AND
 *     end-of-call-report — two messages, arriving 2 seconds apart in both
 *     captures. Whether the session lands in the right state depends on how
 *     those two interact, not on either alone.
 *
 * The fixture is the real capture (agent/data/webhooks.jsonl) sanitized:
 * phone numbers, names, storage URLs, tunnel host and Twilio SIDs replaced.
 * It is committed precisely so this survives the gitignored capture file.
 */

const SEQUENCES = path.join(__dirname, 'fixtures', 'vapi-real', 'call-sequences.json');

// vapiSecretAuth guards /webhook unconditionally; the boot guard requires it.
const TEST_VAPI_SECRET = 'test-vapi-secret';
process.env.VAPI_SECRET = TEST_VAPI_SECRET;

let server;
let baseUrl;
let repository;
let dbDir;

before(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-replay-'));
  repository = new SqliteRepository({ dbPath: path.join(dbDir, 'test.db') });

  const strategy = new MedicationAdherenceStrategy();
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
    providersConfig: {},
    strategy,
    repository,
    webhookUrl: 'http://localhost',
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

function sequences() {
  return JSON.parse(fs.readFileSync(SEQUENCES, 'utf8')).sequences;
}

/** Replay one call, capturing every log line the handler emits. */
async function replay(messages) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args[0]);
  const statuses = [];
  try {
    for (const message of messages) {
      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vapi-secret': TEST_VAPI_SECRET },
        body: JSON.stringify({ message }),
      });
      statuses.push(res.status);
      await res.text();
    }
  } finally {
    console.log = originalLog;
  }
  const events = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { statuses, events };
}

describe('replaying real captured calls end to end', () => {
  test('the fixture really does contain two calls in disagreeing order', () => {
    // Guards the premise. If a future edit normalises the fixture into one
    // tidy order, the ordering assertions below would still pass while
    // testing nothing — so assert the disorder is present.
    const [a, b] = sequences();
    const typesOf = (s) => s.messages.map((m) => m.type);
    const idx = (types, t) => types.indexOf(t);

    const at = typesOf(a);
    const bt = typesOf(b);
    assert.ok(
      idx(at, 'status-update') < idx(at, 'assistant.started'),
      'call 1 should deliver status-update before assistant.started'
    );
    assert.ok(
      idx(bt, 'assistant.started') < idx(bt, 'status-update'),
      'call 2 should deliver assistant.started before status-update — that disagreement is the point'
    );
  });

  for (const [index, seq] of sequences().entries()) {
    describe(`${seq.callId} (${seq.messages.length} messages, real order)`, () => {
      let result;

      before(async () => {
        // Represent origination. No webhook creates the calls row: for an
        // outbound call it is written by transport.createCall() -> openCall()
        // (vapi.js:942) before any webhook arrives, and for inbound by the
        // assistant-request handler (vapi.js:633). Replaying webhooks alone
        // starts the story mid-way, so seed the row the same way origination
        // would — otherwise this asserts a gap the harness invented.
        await repository.createCall({
          callId: seq.callId,
          useCase: 'medication-adherence',
          language: 'hi',
          phone: '+15551234567',
        });
        result = await replay(seq.messages);
      });

      test('every message is answered HTTP 200', () => {
        // A non-2xx on /webhook makes Vapi stall and the caller hears silence.
        assert.deepStrictEqual(
          result.statuses,
          new Array(seq.messages.length).fill(200),
          `statuses were ${result.statuses.join(',')}`
        );
      });

      test('no message is silently discarded as an unknown type', () => {
        const unknown = result.events
          .filter((e) => e.event === 'webhook_unknown_type')
          .map((e) => e.type);
        assert.deepStrictEqual(
          unknown,
          [],
          `real Vapi traffic hit the default: branch — ${unknown.join(', ')}`
        );
      });

      test('no handler error is logged', () => {
        const errors = result.events.filter(
          (e) => e.event === 'webhook_handler_error' || e.event === 'event_bus_handler_error'
        );
        assert.deepStrictEqual(
          errors.map((e) => e.error),
          [],
          'a real captured call raised a handler error'
        );
      });

      test('the call is recorded despite the ordering', async () => {
        // The substantive claim: whichever order the start messages arrived
        // in, the call exists in the database afterwards.
        const call = await repository.getCall(seq.callId);
        assert.ok(
          call,
          `no calls row for ${seq.callId} — order-dependent handling dropped it ` +
            `(this sequence delivered ${seq.messages[0].type} first)`
        );
      });

      test('the end-of-call report actually reaches the database', async () => {
        const report = seq.messages.find((m) => m.type === 'end-of-call-report');
        assert.ok(report, 'fixture should contain an end-of-call-report');
        assert.ok(report.durationSeconds > 0, 'fixture report should carry a duration');

        const call = await repository.getCall(seq.callId);
        assert.ok(call, 'call row missing');

        // The substantive check. Both captured calls ended silence-timed-out
        // with an empty transcript, so the derived LABEL is uninteresting —
        // but the duration is a value that exists only in the report. If it
        // is on the row, the report was parsed and written; if it is null,
        // the report was discarded behind a 200 OK, which is exactly the
        // failure this whole fixture exists to catch.
        assert.strictEqual(
          Math.round(call.duration_seconds),
          Math.round(report.durationSeconds),
          'the duration from the real end-of-call-report never reached the calls row'
        );
      });
    });
  }
});
