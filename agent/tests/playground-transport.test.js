'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PlaygroundTransportAdapter = require('../src/adapters/transport/playground');
const TransportPort = require('../src/core/ports/transport');
const TransportRegistry = require('../src/adapters/transport/registry');
const ProviderRegistry = require('../src/adapters/providers/registry');
const SqliteRepository = require('../src/adapters/persistence/sqlite');

/**
 * Task 3 — the playground as a real transport.
 *
 * These drive PlaygroundTransportAdapter directly against a temp SQLite
 * repository, with no browser and no WebSocket — the playground equivalent
 * of tests/resume-e2e.test.js. The point under test is that the playground
 * shares the phone path's lifecycle module rather than a parallel
 * implementation of it.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-playground-transport-')),
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

const PATIENT = { phone: '+919876500077', name: 'Kavita-ji', drugName: 'Amlodipine', language: 'hi' };

describe('PlaygroundTransportAdapter', () => {
  test('is registered in TransportRegistry and implements TransportPort', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    assert.ok(reg.getAvailableTransports().includes('playground'));
    const transport = reg.getTransport('playground');
    assert.ok(transport instanceof TransportPort);
    assert.ok(transport instanceof PlaygroundTransportAdapter);
  });

  test('mints a session id that is obviously a playground id, not a real call id', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const adapter = new PlaygroundTransportAdapter(null);
    adapter.repository = repo;

    const { sessionId } = await adapter.openSession({ phone: PATIENT.phone, direction: 'inbound' });

    assert.ok(sessionId.startsWith(PlaygroundTransportAdapter.SESSION_ID_PREFIX));
    assert.notStrictEqual(sessionId, PATIENT.phone);
  });

  test('an inbound open for an unknown caller creates a patient and opens in inbound mode', async () => {
    const repo = freshRepo();
    const adapter = new PlaygroundTransportAdapter(null);
    adapter.repository = repo;

    const result = await adapter.openSession({ phone: '+919999999888', direction: 'inbound' });

    assert.strictEqual(result.mode, 'inbound');
    assert.ok(result.patient);
    const session = await repo.getSession(result.sessionId);
    assert.strictEqual(session.direction, 'inbound');
    assert.strictEqual(session.status, 'active');
  });

  test('an outbound open for a known patient opens an outbound session', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const adapter = new PlaygroundTransportAdapter(null);
    adapter.repository = repo;

    const result = await adapter.openSession({ phone: PATIENT.phone, direction: 'outbound' });

    assert.strictEqual(result.mode, 'outbound');
    const session = await repo.getSession(result.sessionId);
    assert.strictEqual(session.direction, 'outbound');
  });

  test('the full drop-and-resume loop: open, capture, close dropped, open again resumes', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const adapter = new PlaygroundTransportAdapter(null);
    adapter.repository = repo;

    // 1. Open an inbound session.
    const first = await adapter.openSession({ phone: PATIENT.phone, direction: 'inbound' });
    assert.strictEqual(first.mode, 'inbound');

    // 2. Capture a field mid-conversation.
    const COMPLAINT = 'साँस फूलती है';
    await adapter.captureField({ sessionId: first.sessionId, field: 'chief_complaint', value: COMPLAINT });

    const fields = await repo.getSessionFields(first.sessionId);
    assert.strictEqual(fields.chief_complaint, COMPLAINT);

    // 3. Close the session as dropped (browser disconnect, not a reported outcome).
    await adapter.closeSession({ sessionId: first.sessionId, endedReason: undefined });
    const closed = await repo.getSession(first.sessionId);
    assert.strictEqual(closed.status, 'dropped');

    // 4. Open again for the same patient — must resolve to resume, carrying
    // the field captured in step 2.
    const second = await adapter.openSession({ phone: PATIENT.phone, direction: 'inbound' });
    assert.strictEqual(second.mode, 'resume');
    assert.strictEqual(second.fieldsSoFar.chief_complaint, COMPLAINT);
    assert.notStrictEqual(second.sessionId, first.sessionId);
  });

  test('closing with a normal ended reason resolves to completed, not resumable', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const adapter = new PlaygroundTransportAdapter(null);
    adapter.repository = repo;

    const opened = await adapter.openSession({ phone: PATIENT.phone, direction: 'inbound' });
    await adapter.closeSession({ sessionId: opened.sessionId, endedReason: 'customer-ended-call' });

    const closed = await repo.getSession(opened.sessionId);
    assert.strictEqual(closed.status, 'completed');

    const reopened = await adapter.openSession({ phone: PATIENT.phone, direction: 'inbound' });
    assert.strictEqual(reopened.mode, 'inbound', 'a completed session must not be offered for resume');
  });

  test('capturing an unknown field is tolerated, not thrown', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const adapter = new PlaygroundTransportAdapter(null);
    adapter.repository = repo;

    const opened = await adapter.openSession({ phone: PATIENT.phone, direction: 'inbound' });

    await assert.doesNotReject(
      adapter.captureField({ sessionId: opened.sessionId, field: 'favourite_colour', value: 'blue' })
    );
    assert.deepStrictEqual(await repo.getSessionFields(opened.sessionId), {});
  });

  test('start() mounts a patient-listing route for the picker', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const adapter = new PlaygroundTransportAdapter(null);

    let mountedPath;
    let handler;
    const fakeApp = { get: (p, h) => { mountedPath = p; handler = h; } };

    await adapter.start(null, null, { app: fakeApp, repository: repo, strategy: {} });

    assert.strictEqual(mountedPath, '/api/playground/patients');

    let jsonBody;
    const fakeRes = { json: (b) => { jsonBody = b; } };
    await handler({}, fakeRes);

    assert.ok(Array.isArray(jsonBody.patients));
    assert.strictEqual(jsonBody.patients.length, 1);
    assert.strictEqual(jsonBody.patients[0].phone_e164, PATIENT.phone);
  });
});
