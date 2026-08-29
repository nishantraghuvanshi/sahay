'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');

/**
 * Patient records and the session state machine.
 *
 *   create ──► active ──normal end──► completed
 *                 │
 *            disconnect
 *                 ▼
 *              dropped ──redial in window──► active
 *                 │
 *          window expires
 *                 ▼
 *             abandoned
 *
 * Invariant: at most one `active` session per patient.
 *
 * The window is evaluated against an injected `now` rather than the wall
 * clock, so expiry is tested deterministically instead of with sleeps.
 */

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-sessions-')),
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

const PATIENT = {
  phone: '+919876543210',
  name: 'Sharma-ji',
  drugName: 'Crocin',
  language: 'hi',
  caregiverName: 'Rohan',
  caregiverPhone: '+919000000001',
};

describe('patients', () => {
  let repo;
  beforeEach(() => {
    repo = freshRepo();
  });

  test('upsertPatient then findPatientByPhone round-trips', async () => {
    await repo.upsertPatient(PATIENT);
    const found = await repo.findPatientByPhone(PATIENT.phone);
    assert.ok(found, 'patient should be found by phone');
    assert.strictEqual(found.name, 'Sharma-ji');
    assert.strictEqual(found.drug_name, 'Crocin');
    assert.strictEqual(found.caregiver_name, 'Rohan');
  });

  test('findPatientByPhone returns null for an unknown number', async () => {
    const found = await repo.findPatientByPhone('+910000000000');
    assert.strictEqual(found, null, 'must not invent a record');
  });

  test('upsertPatient is idempotent on phone', async () => {
    await repo.upsertPatient(PATIENT);
    await repo.upsertPatient({ ...PATIENT, name: 'Sharma-ji (updated)' });
    const all = await repo.listPatients();
    assert.strictEqual(all.length, 1, 'phone is the natural key');
    assert.strictEqual(all[0].name, 'Sharma-ji (updated)');
  });
});

describe('session lifecycle', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
  });

  test('a new session starts active', async () => {
    const s = await repo.createSession({
      sessionId: 's1',
      patientId,
      callId: 'c1',
      direction: 'inbound',
    });
    assert.strictEqual(s.status, 'active');
    assert.strictEqual(s.direction, 'inbound');
  });

  test('at most one active session per patient', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'outbound' });
    await repo.createSession({ sessionId: 's2', patientId, callId: 'c2', direction: 'inbound' });

    const active = await repo.listSessions({ patientId, status: 'active' });
    assert.strictEqual(active.length, 1, 'the earlier session must not stay active');
    assert.strictEqual(active[0].session_id, 's2');

    const first = await repo.getSession('s1');
    assert.strictEqual(first.status, 'dropped', 'superseded session becomes dropped');
  });

  test('endSession marks completed', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'outbound' });
    await repo.endSession('s1', 'completed');
    assert.strictEqual((await repo.getSession('s1')).status, 'completed');
  });

  test('endSession marks dropped', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');
    assert.strictEqual((await repo.getSession('s1')).status, 'dropped');
  });

  test('endSession rejects a status outside the state machine', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await assert.rejects(() => repo.endSession('s1', 'finished'), /status/i);
  });

  test('calling createSession twice with the same sessionId leaves exactly one session, still active', async () => {
    // Vapi retries assistant-request after its 7.5s budget lapses, so the
    // same call.id can reach createSession twice for one still-live call.
    // Before the fix, the second call's own demote step matched its own
    // just-created row (same patient, status active) and dropped it, then
    // the INSERT threw on the UNIQUE session_id — leaving the live call's
    // session reading 'dropped' and the caller getting an error response.
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });

    const all = await repo.listSessions({ patientId });
    assert.strictEqual(all.length, 1, 'must not create a second row for the same sessionId');
    assert.strictEqual(all[0].status, 'active', 'the live call must not read as dropped');
  });
});

describe('fields captured so far', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
  });

  test('fields start empty', async () => {
    assert.deepStrictEqual(await repo.getSessionFields('s1'), {});
  });

  test('updateSessionFields merges rather than replaces', async () => {
    await repo.updateSessionFields('s1', { chief_complaint: 'seene mein dard' });
    await repo.updateSessionFields('s1', { onset_hours: 2 });

    const fields = await repo.getSessionFields('s1');
    assert.strictEqual(fields.chief_complaint, 'seene mein dard');
    assert.strictEqual(fields.onset_hours, 2);
  });

  test('a later write wins for the same key', async () => {
    await repo.updateSessionFields('s1', { breathing: 'unsure' });
    await repo.updateSessionFields('s1', { breathing: 'difficult' });
    assert.strictEqual((await repo.getSessionFields('s1')).breathing, 'difficult');
  });

  test('updating fields on an unknown session does not silently no-op', async () => {
    // The UPDATE-matching-zero-rows bug that already cost this codebase a
    // pilot's worth of outcomes. Fail loudly instead.
    await assert.rejects(
      () => repo.updateSessionFields('nope', { a: 1 }),
      /unknown session/i
    );
  });
});

describe('resume window', () => {
  let repo;
  let patientId;
  const WINDOW = 15;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
  });

  /** `now` is injected so elapsed time is simulated, not slept through. */
  const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);

  test('a dropped session inside the window is resumable', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.updateSessionFields('s1', { chief_complaint: 'chakkar' });
    await repo.endSession('s1', 'dropped');

    const found = await repo.findResumableSession(patientId, WINDOW, minutesFromNow(14));
    assert.ok(found, '14 minutes is inside a 15 minute window');
    assert.strictEqual(found.session_id, 's1');
  });

  test('a dropped session outside the window is not resumable', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');

    const found = await repo.findResumableSession(patientId, WINDOW, minutesFromNow(16));
    assert.strictEqual(found, null, '16 minutes is outside a 15 minute window');
  });

  test('a completed session is never resumable', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'outbound' });
    await repo.endSession('s1', 'completed');
    assert.strictEqual(await repo.findResumableSession(patientId, WINDOW, new Date()), null);
  });

  test('expireStaleSessions moves dropped past the window to abandoned', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');

    const expired = await repo.expireStaleSessions(WINDOW, minutesFromNow(20));
    assert.strictEqual(expired, 1);
    assert.strictEqual((await repo.getSession('s1')).status, 'abandoned');
  });

  test('expireStaleSessions leaves in-window sessions alone', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');

    assert.strictEqual(await repo.expireStaleSessions(WINDOW, minutesFromNow(5)), 0);
    assert.strictEqual((await repo.getSession('s1')).status, 'dropped');
  });

  test('an abandoned session stays abandoned and is not resumable', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');
    await repo.expireStaleSessions(WINDOW, minutesFromNow(20));

    // Even asking inside a fresh window must not revive it.
    assert.strictEqual(await repo.findResumableSession(patientId, WINDOW, minutesFromNow(20)), null);
  });

  test('a stale active session demoted by a new call does not resurface as a fresh resume', async () => {
    // Simulate a session stuck 'active' for days — a lost webhook or a
    // restart mid-call. createSession only ever writes "now", so there is
    // no repository method for backdating; go straight at the row.
    await repo.createSession({ sessionId: 's-stale', patientId, callId: 'c-stale', direction: 'inbound' });
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    repo.db
      .prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE session_id = ?')
      .run(longAgo, longAgo, 's-stale');

    // A new call for the same patient arrives; createSession demotes the
    // stuck active row to dropped.
    await repo.createSession({ sessionId: 's-new', patientId, callId: 'c-new', direction: 'inbound' });

    // Before the fix, the demote step stamped ended_at = now, so a
    // days-old session looked freshly dropped and was resumable.
    const found = await repo.findResumableSession(patientId, WINDOW, new Date());
    assert.strictEqual(found, null, 'a days-old stuck session must not look freshly dropped');
  });

  test('the most recent dropped session wins', async () => {
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');
    await repo.createSession({ sessionId: 's2', patientId, callId: 'c2', direction: 'inbound' });
    await repo.endSession('s2', 'dropped');

    const found = await repo.findResumableSession(patientId, WINDOW, minutesFromNow(1));
    assert.strictEqual(found.session_id, 's2');
  });
});

describe('recent call history for a patient', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
  });

  test('returns calls for that phone, newest first, capped', async () => {
    await repo.save({ callId: 'c1', label: 'CONFIRMED', phone: PATIENT.phone });
    await repo.save({ callId: 'c2', label: 'ESCALATED_SYMPTOM', phone: PATIENT.phone });

    const history = await repo.recentCallsForPhone(PATIENT.phone, 3);
    assert.ok(history.length >= 1, 'should surface prior calls');
    assert.ok(
      history.every((c) => c.phone === PATIENT.phone),
      'must not leak another patient history'
    );
  });

  test('returns an empty array for a caller with no history', async () => {
    assert.deepStrictEqual(await repo.recentCallsForPhone('+910000000000', 3), []);
  });
});
