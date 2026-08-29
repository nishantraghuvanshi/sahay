'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');

/**
 * Task 3 — outbound calls open a session too, so a dropped dose reminder is
 * resumable the same way a dropped inbound call is.
 *
 * These tests exercise VapiTransportAdapter's session-opening logic
 * directly against a temp SqliteRepository. They never call the Vapi API —
 * createCall's HTTP dispatch is out of scope here; only what happens after
 * Vapi returns a call is under test.
 */

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-outbound-session-')),
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

/** Adapter with just enough wiring for _openOutboundSession — no Vapi start(). */
function adapterFor(repo) {
  const adapter = new VapiTransportAdapter(null);
  adapter.repository = repo;
  return adapter;
}

const PATIENT = {
  phone: '+919876543210',
  name: 'Sharma-ji',
  drugName: 'Crocin',
  language: 'hi',
};

describe('outbound call session opening', () => {
  let repo;
  let adapter;

  beforeEach(() => {
    repo = freshRepo();
    adapter = adapterFor(repo);
  });

  test('known patient gets an outbound session with the call id', async () => {
    await repo.upsertPatient(PATIENT);
    const patient = await repo.findPatientByPhone(PATIENT.phone);

    await adapter._openOutboundSession({ id: 'call-outbound-1' }, PATIENT.phone);

    const session = await repo.getSession('call-outbound-1');
    assert.ok(session, 'session should have been created');
    assert.strictEqual(session.direction, 'outbound');
    assert.strictEqual(session.session_id, 'call-outbound-1');
    assert.strictEqual(session.call_id, 'call-outbound-1');
    assert.strictEqual(session.patient_id, patient.id);
    assert.strictEqual(session.status, 'active');
  });

  test('unknown phone creates neither a session nor a patient', async () => {
    await adapter._openOutboundSession({ id: 'call-outbound-2' }, '+910000000000');

    const session = await repo.getSession('call-outbound-2');
    assert.strictEqual(session, null);

    const patient = await repo.findPatientByPhone('+910000000000');
    assert.strictEqual(patient, null);
  });

  test('opening an outbound session while one is active demotes the older one', async () => {
    await repo.upsertPatient(PATIENT);
    const patient = await repo.findPatientByPhone(PATIENT.phone);

    await adapter._openOutboundSession({ id: 'call-outbound-3' }, PATIENT.phone);
    const first = await repo.getSession('call-outbound-3');
    assert.strictEqual(first.status, 'active');

    await adapter._openOutboundSession({ id: 'call-outbound-4' }, PATIENT.phone);

    const demoted = await repo.getSession('call-outbound-3');
    assert.strictEqual(demoted.status, 'dropped');

    const second = await repo.getSession('call-outbound-4');
    assert.strictEqual(second.status, 'active');
    assert.strictEqual(second.patient_id, patient.id);
  });

  test('a persistence failure while opening a session does not propagate', async () => {
    await repo.upsertPatient(PATIENT);
    repo.createSession = async () => {
      throw new Error('boom');
    };

    await assert.doesNotReject(
      adapter._openOutboundSession({ id: 'call-outbound-5' }, PATIENT.phone)
    );
  });
});
