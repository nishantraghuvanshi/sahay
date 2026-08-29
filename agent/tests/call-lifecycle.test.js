'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openCall, captureField, closeCall } = require('../src/core/call/lifecycle');
const SqliteRepository = require('../src/adapters/persistence/sqlite');

/**
 * Task 1 — call lifecycle extracted out of the Vapi adapter.
 *
 * These drive openCall/captureField/closeCall directly against a temp
 * SQLite repository, the same way the phone-path tests they replace duty
 * for (inbound-session-open, outbound-session, capture-field, resume-e2e)
 * exercise the webhook handler. The vapi.js tests still cover the webhook
 * wiring; this file covers the lifecycle module itself, including the
 * tolerant paths a real call can hit (unknown field, unknown session,
 * absent call id).
 */

const ALLOWED_FIELDS = ['chief_complaint', 'onset', 'breathing', 'who_is_with_you'];

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-call-lifecycle-')),
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

const PATIENT = { phone: '+919876500099', name: 'Asha-ji', drugName: 'Metformin', language: 'hi' };

describe('openCall — inbound', () => {
  test('unknown caller is created and opened in inbound mode', async () => {
    const repo = freshRepo();

    const result = await openCall({ repository: repo, phone: '+919999999999', direction: 'inbound', callId: 'call-1' });

    assert.strictEqual(result.mode, 'inbound');
    assert.ok(result.patient, 'a patient record should have been created');
    assert.strictEqual(result.isNewPatient, true);
    assert.deepStrictEqual(result.fieldsSoFar, {});

    const session = await repo.getSession('call-1');
    assert.ok(session, 'a session should have been opened for this call');
    assert.strictEqual(session.direction, 'inbound');
  });

  test('a known caller with a resumable session opens in resume mode carrying fields', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const patient = await repo.findPatientByPhone(PATIENT.phone);

    // First call: capture a field, then drop it.
    await openCall({ repository: repo, phone: PATIENT.phone, direction: 'inbound', callId: 'call-2a' });
    await captureField({ repository: repo, callId: 'call-2a', field: 'chief_complaint', value: 'बुखार', allowedFields: ALLOWED_FIELDS });
    await closeCall({ repository: repo, callId: 'call-2a', endedReason: 'pipeline-error-openai-llm-failed' });

    // Second call, same patient: should resume with the captured field.
    const result = await openCall({ repository: repo, phone: PATIENT.phone, direction: 'inbound', callId: 'call-2b' });

    assert.strictEqual(result.mode, 'resume');
    assert.strictEqual(result.patient.id, patient.id);
    assert.strictEqual(result.fieldsSoFar.chief_complaint, 'बुखार');
  });

  test('a missing call id opens no session, even for a known patient', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    const result = await openCall({ repository: repo, phone: PATIENT.phone, direction: 'inbound', callId: null });

    assert.ok(result.patient, 'the caller should still resolve to a patient');
    assert.strictEqual(result.session, null);

    const sessions = await repo.listSessions();
    assert.strictEqual(sessions.length, 0, 'no session should have been created without a call id');
  });
});

describe('openCall — outbound', () => {
  test('a known patient gets an outbound session with the call id', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const patient = await repo.findPatientByPhone(PATIENT.phone);

    const result = await openCall({ repository: repo, phone: PATIENT.phone, direction: 'outbound', callId: 'call-out-1' });

    assert.strictEqual(result.mode, 'outbound');
    assert.strictEqual(result.patient.id, patient.id);
    const session = await repo.getSession('call-out-1');
    assert.strictEqual(session.direction, 'outbound');
    assert.strictEqual(session.status, 'active');
  });

  test('an unknown phone creates neither a session nor a patient', async () => {
    const repo = freshRepo();

    const result = await openCall({ repository: repo, phone: '+910000000001', direction: 'outbound', callId: 'call-out-2' });

    assert.strictEqual(result.patient, null);
    assert.strictEqual(result.session, null);
    assert.strictEqual(await repo.getSession('call-out-2'), null);
    assert.strictEqual(await repo.findPatientByPhone('+910000000001'), null);
  });

  test('a persistence failure while opening an outbound session does not propagate', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    repo.createSession = async () => {
      throw new Error('boom');
    };

    await assert.doesNotReject(
      openCall({ repository: repo, phone: PATIENT.phone, direction: 'outbound', callId: 'call-out-3' })
    );
  });
});

describe('captureField', () => {
  test('writes a known field to a live session', async () => {
    const repo = freshRepo();
    await repo.createSession({ sessionId: 'call-3', patientId: null });

    await captureField({ repository: repo, callId: 'call-3', field: 'onset', value: 'तीन दिन से', allowedFields: ALLOWED_FIELDS });

    const fields = await repo.getSessionFields('call-3');
    assert.strictEqual(fields.onset, 'तीन दिन से');
  });

  test('an unknown field name is logged and dropped, not written', async () => {
    const repo = freshRepo();
    await repo.createSession({ sessionId: 'call-4', patientId: null });

    await captureField({ repository: repo, callId: 'call-4', field: 'favourite_colour', value: 'blue', allowedFields: ALLOWED_FIELDS });

    assert.deepStrictEqual(await repo.getSessionFields('call-4'), {});
  });

  test('an unknown session is logged and does not throw', async () => {
    const repo = freshRepo();

    await assert.doesNotReject(
      captureField({ repository: repo, callId: 'no-such-call', field: 'onset', value: 'today', allowedFields: ALLOWED_FIELDS })
    );
  });

  test('an absent call id is logged and does not throw', async () => {
    const repo = freshRepo();

    await assert.doesNotReject(
      captureField({ repository: repo, callId: null, field: 'onset', value: 'today', allowedFields: ALLOWED_FIELDS })
    );
  });
});

describe('closeCall', () => {
  test('a normal ended reason closes the session as completed', async () => {
    const repo = freshRepo();
    await repo.createSession({ sessionId: 'call-5', patientId: null });

    await closeCall({ repository: repo, callId: 'call-5', endedReason: 'customer-ended-call' });

    const session = await repo.getSession('call-5');
    assert.strictEqual(session.status, 'completed');
  });

  test('an abnormal ended reason closes the session as dropped, making it resumable', async () => {
    const repo = freshRepo();
    await repo.createSession({ sessionId: 'call-6', patientId: null });

    await closeCall({ repository: repo, callId: 'call-6', endedReason: 'pipeline-error-openai-llm-failed' });

    const session = await repo.getSession('call-6');
    assert.strictEqual(session.status, 'dropped');
  });

  test('an unknown session is logged and does not throw', async () => {
    const repo = freshRepo();

    await assert.doesNotReject(
      closeCall({ repository: repo, callId: 'no-such-call', endedReason: 'customer-ended-call' })
    );
  });

  test('an absent call id is logged and does not throw', async () => {
    const repo = freshRepo();

    await assert.doesNotReject(
      closeCall({ repository: repo, callId: null, endedReason: 'customer-ended-call' })
    );
  });
});
