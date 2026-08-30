'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const { createDoseTick } = require('../src/use-cases/medication-adherence/scheduling/tick');
const { createScheduler } = require('../src/core/scheduler/loop');
const { MAX_ATTEMPTS } = require('../src/use-cases/medication-adherence/scheduling/policy');

/**
 * spec: .superpowers/sdd/scheduler/task-3-brief.md, task-4-brief.md
 *
 * The join everything upstream (dueDoseEvents, decideDial, recordDoseAttempt,
 * createScheduler) was built for but nothing ever called: a tick that reads
 * due doses, asks the policy what to do, and drives the injected `dial` and
 * repository writes accordingly.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-dose-tick-')), 'test.db');
  tmpDbs.push(dbPath);
  return new SqliteRepository({ dbPath });
}

after(() => {
  for (const p of tmpDbs) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

function fakeLogger() {
  const logs = [];
  const errors = [];
  return {
    log: (event, data) => logs.push({ event, data }),
    error: (event, err, data) => errors.push({ event, err, data }),
    logs,
    errors,
  };
}

/** Records every call it's given instead of actually dialling anything. */
function fakeDial(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return impl ? impl(args) : { callId: `call-${calls.length}` };
  };
  fn.calls = calls;
  return fn;
}

const PATIENT = {
  phone: '+919876543210',
  name: 'Sharma-ji',
  drugName: 'Metformin',
  language: 'hi',
};

const MED = {
  name: 'Metformin',
  dose: '500mg',
  times: ['08:00'],
  foodRule: 'after',
  startDate: '2026-01-01',
  endDate: null,
  active: true,
};

const SIGNED_OFF_AT = '2026-01-01T00:00:00.000Z';
const SLOT_TIME = '2026-08-30T02:30:00.000Z'; // 08:00 Asia/Kolkata
const NOW = new Date('2026-08-30T02:30:00.000Z');

describe('createDoseTick', () => {
  let repo;
  let patientId;
  let medicationId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const patient = await repo.findPatientByPhone(PATIENT.phone);
    patientId = patient.id;
    await repo.setPatientSchedule(patientId, { signedOffAt: SIGNED_OFF_AT });
    const med = await repo.upsertMedication({ ...MED, patientId });
    medicationId = med.id;
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime: SLOT_TIME });
  });

  test('a due dose gets dialled', async () => {
    const dial = fakeDial();
    const tick = createDoseTick({ repository: repo, dial, now: () => NOW, logger: fakeLogger() });

    await tick();

    assert.strictEqual(dial.calls.length, 1);
    assert.strictEqual(dial.calls[0].doseEvent.slot_time, SLOT_TIME);
    assert.strictEqual(dial.calls[0].patient.id, patientId);
    assert.strictEqual(dial.calls[0].medication.id, medicationId);

    const [event] = await repo.listDoseEvents({ patientId });
    assert.strictEqual(event.attempt_count, 1);
    assert.strictEqual(event.call_id, 'call-1');
  });

  test('a dose inside a quiet window does not get dialled', async () => {
    await repo.setPatientSchedule(patientId, {
      signedOffAt: SIGNED_OFF_AT,
      quietWindows: [{ start: '07:00', end: '09:00' }], // covers 08:00 IST
    });
    const dial = fakeDial();
    const tick = createDoseTick({ repository: repo, dial, now: () => NOW, logger: fakeLogger() });

    await tick();

    assert.strictEqual(dial.calls.length, 0);
    const [event] = await repo.listDoseEvents({ patientId });
    assert.strictEqual(event.attempt_count, 0);
    assert.strictEqual(event.status, 'pending');
  });

  test('a patient with an active session is skipped, not dialled', async () => {
    await repo.createSession({
      sessionId: 'sess-active-1',
      patientId,
      callId: 'call-active-1',
      direction: 'outbound',
    });
    const dial = fakeDial();
    const tick = createDoseTick({ repository: repo, dial, now: () => NOW, logger: fakeLogger() });

    await tick();

    assert.strictEqual(dial.calls.length, 0);
    const [event] = await repo.listDoseEvents({ patientId });
    assert.strictEqual(event.attempt_count, 0);
  });

  test('a dose past max attempts is not retried forever and resolves to unknown', async () => {
    await repo.recordDoseAttempt(medicationId, SLOT_TIME, {
      attemptCount: MAX_ATTEMPTS,
      nextAttemptAt: null,
      now: NOW,
    });
    const dial = fakeDial();
    const tick = createDoseTick({ repository: repo, dial, now: () => NOW, logger: fakeLogger() });

    await tick();

    assert.strictEqual(dial.calls.length, 0);
    const [event] = await repo.listDoseEvents({ patientId });
    assert.strictEqual(event.status, 'unknown');
  });

  test('one dial throwing does not prevent the next dose being processed', async () => {
    const med2 = await repo.upsertMedication({
      ...MED,
      name: 'Amlodipine',
      patientId,
    });
    await repo.upsertDoseEvent({ medicationId: med2.id, patientId, slotTime: SLOT_TIME });

    let callNum = 0;
    const dial = fakeDial(() => {
      callNum += 1;
      if (callNum === 1) throw new Error('boom');
      return { callId: 'call-ok' };
    });
    const log = fakeLogger();
    const tick = createDoseTick({ repository: repo, dial, now: () => NOW, logger: log });

    await tick();

    assert.strictEqual(dial.calls.length, 2, 'both doses were attempted despite the first throwing');
    assert.ok(
      log.errors.some((e) => e.event === 'scheduler_dose_tick_failed'),
      'the failure was logged distinctly rather than swallowed'
    );
  });

  test('two overlapping ticks do not double-dial the same dose', async () => {
    const dial = fakeDial();
    const tick = createDoseTick({ repository: repo, dial, now: () => NOW, logger: fakeLogger() });
    const scheduler = createScheduler({ tick, intervalMs: 1000, logger: fakeLogger() });

    // Fire both without awaiting the first — single-flight in loop.js plus
    // the pre-dial recordDoseAttempt write are what should stop a double dial.
    await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);

    assert.strictEqual(dial.calls.length, 1);
  });

  test('expireStaleSessions is invoked on every tick', async () => {
    await repo.createSession({
      sessionId: 'sess-stale-1',
      patientId,
      callId: 'call-stale-1',
      direction: 'outbound',
    });
    // Inject the same clock the tick runs on. Without this the row is stamped
    // with real wall-clock time while the assertion reasons about NOW, so the
    // test passes only while the two happen to coincide.
    await repo.endSession('sess-stale-1', 'dropped', NOW);

    const farFuture = new Date(NOW.getTime() + 60 * 60_000); // 1h later, past a 15min window
    const dial = fakeDial();
    const tick = createDoseTick({ repository: repo, dial, now: () => farFuture, logger: fakeLogger() });

    await tick();

    const [session] = await repo.listSessions({ patientId });
    assert.strictEqual(session.status, 'abandoned');
  });
});
