'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');

/**
 * spec: .superpowers/sdd/scheduler/task-2-brief.md
 *
 * The gate columns a dial-decision policy (a later task) will read:
 * patients.schedule_signed_off_at / quiet_windows, medications.is_priority,
 * dose_events.attempt_count / next_attempt_at — plus the CRUD-only
 * repository methods that write them. No dial-decision logic lives here.
 */

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-scheduling-schema-')),
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

describe('gate columns exist on a fresh database', () => {
  test('patients, medications and dose_events all carry the new columns', async () => {
    const repo = freshRepo();
    const patientCols = repo.db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
    const medCols = repo.db.prepare('PRAGMA table_info(medications)').all().map((c) => c.name);
    const doseCols = repo.db.prepare('PRAGMA table_info(dose_events)').all().map((c) => c.name);

    assert.ok(patientCols.includes('schedule_signed_off_at'));
    assert.ok(patientCols.includes('quiet_windows'));
    assert.ok(medCols.includes('is_priority'));
    assert.ok(doseCols.includes('attempt_count'));
    assert.ok(doseCols.includes('next_attempt_at'));

    await repo.close();
  });
});

describe('opening a pre-existing, compatible database adds the missing gate columns', () => {
  test('opening a pre-existing database without the gate columns adds them, not crashes', async () => {
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-scheduling-schema-legacy-')),
      'test.db'
    );
    tmpDbs.push(dbPath);

    // Simulate a database from before this task: the same core tables, TEXT
    // ids and the post-reconciliation column names (matching schema.sql),
    // none of the new gate columns. TEXT ids and current names are the
    // point — an INTEGER id or a pre-rename column name is a *different*,
    // incompatible case, covered by schema-version.test.js.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT UNIQUE NOT NULL,
        name TEXT,
        drug_name TEXT,
        language TEXT,
        notes TEXT,
        timezone TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      );
      CREATE TABLE medications (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        name TEXT NOT NULL,
        dose TEXT,
        slots TEXT NOT NULL DEFAULT '[]',
        with_food TEXT,
        start_date TEXT NOT NULL DEFAULT (date('now')),
        end_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE dose_events (
        id TEXT PRIMARY KEY,
        medication_id TEXT NOT NULL,
        patient_id TEXT NOT NULL,
        slot_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        actor TEXT,
        confirmed_at TEXT,
        call_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    // Constructing SqliteRepository against this path must not throw, and
    // must add every gate column via ALTER TABLE.
    const repo = new SqliteRepository({ dbPath });
    const patientCols = repo.db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
    const medCols = repo.db.prepare('PRAGMA table_info(medications)').all().map((c) => c.name);
    const doseCols = repo.db.prepare('PRAGMA table_info(dose_events)').all().map((c) => c.name);

    assert.ok(patientCols.includes('schedule_signed_off_at'));
    assert.ok(patientCols.includes('quiet_windows'));
    assert.ok(medCols.includes('is_priority'));
    assert.ok(doseCols.includes('attempt_count'));
    assert.ok(doseCols.includes('next_attempt_at'));

    // Re-opening the now-migrated database a second time must not attempt
    // to re-add the columns (which would throw against SQLite).
    await repo.close();
    assert.doesNotThrow(() => {
      const reopened = new SqliteRepository({ dbPath });
      reopened.close();
    });
  });
});

describe('setPatientSchedule', () => {
  let repo;
  let patientId;

  const freshPatient = async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
  };

  test('sets sign-off, quiet windows and timezone together', async () => {
    await freshPatient();
    const quietWindows = [{ start: '22:00', end: '06:00' }];
    const signedOffAt = '2026-08-30T10:00:00.000Z';

    const updated = await repo.setPatientSchedule(patientId, {
      signedOffAt,
      quietWindows,
      timezone: 'America/New_York',
    });

    assert.strictEqual(updated.schedule_signed_off_at, signedOffAt);
    assert.strictEqual(updated.timezone, 'America/New_York');
    // quiet_windows is stored and returned as a raw JSON string, matching
    // how medications.times is handled — the caller parses it, not this
    // repository layer.
    assert.strictEqual(typeof updated.quiet_windows, 'string');
    assert.deepStrictEqual(JSON.parse(updated.quiet_windows), quietWindows);
  });

  test('a null schedule_signed_off_at means no call is ever placed, and is the default', async () => {
    await freshPatient();
    const patient = await repo.findPatientByPhone(PATIENT.phone);
    assert.strictEqual(patient.schedule_signed_off_at, null);
  });

  test('is a partial patch: setting only signedOffAt leaves quietWindows and timezone untouched', async () => {
    await freshPatient();
    const quietWindows = [{ start: '21:00', end: '07:00' }];
    await repo.setPatientSchedule(patientId, { quietWindows, timezone: 'Asia/Kolkata' });

    const updated = await repo.setPatientSchedule(patientId, {
      signedOffAt: '2026-08-30T10:00:00.000Z',
    });

    assert.strictEqual(updated.schedule_signed_off_at, '2026-08-30T10:00:00.000Z');
    assert.deepStrictEqual(JSON.parse(updated.quiet_windows), quietWindows);
    assert.strictEqual(updated.timezone, 'Asia/Kolkata');
  });

  test('an explicit null revokes a prior sign-off', async () => {
    await freshPatient();
    await repo.setPatientSchedule(patientId, { signedOffAt: '2026-08-30T10:00:00.000Z' });
    const revoked = await repo.setPatientSchedule(patientId, { signedOffAt: null });
    assert.strictEqual(revoked.schedule_signed_off_at, null);
  });

  test('throws on an unknown patient rather than silently matching zero rows', async () => {
    await freshPatient();
    await assert.rejects(
      () => repo.setPatientSchedule(999999, { signedOffAt: '2026-08-30T10:00:00.000Z' }),
      /Unknown patient/i
    );
  });

  test('throws when called with no fields to update', async () => {
    await freshPatient();
    await assert.rejects(() => repo.setPatientSchedule(patientId, {}));
  });
});

describe('medications.is_priority', () => {
  test('defaults to 0 and round-trips through upsertMedication', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;

    const med = await repo.upsertMedication({ ...MED, patientId });
    assert.strictEqual(med.is_priority, 0);
  });
});

describe('recordDoseAttempt', () => {
  let repo;
  let patientId;
  let medicationId;
  const slotTime = '2026-01-01T08:00:00.000Z';

  const freshDose = async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
    const med = await repo.upsertMedication({ ...MED, patientId });
    medicationId = med.id;
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });
  };

  test('records callId, attemptCount and nextAttemptAt without touching status', async () => {
    await freshDose();
    const nextAttemptAt = '2026-01-01T08:05:00.000Z';

    const updated = await repo.recordDoseAttempt(medicationId, slotTime, {
      callId: 'call-abc',
      attemptCount: 1,
      nextAttemptAt,
      now: new Date('2026-01-01T08:00:00.000Z'),
    });

    assert.strictEqual(updated.call_id, 'call-abc');
    assert.strictEqual(updated.attempt_count, 1);
    assert.strictEqual(updated.next_attempt_at, nextAttemptAt);
    assert.strictEqual(updated.status, 'pending', 'recording an attempt is not a resolution');
  });

  test('a later attempt overwrites the earlier callId, attemptCount and nextAttemptAt', async () => {
    await freshDose();
    await repo.recordDoseAttempt(medicationId, slotTime, {
      callId: 'call-1',
      attemptCount: 1,
      nextAttemptAt: '2026-01-01T08:05:00.000Z',
    });
    const updated = await repo.recordDoseAttempt(medicationId, slotTime, {
      callId: 'call-2',
      attemptCount: 2,
      nextAttemptAt: '2026-01-01T08:15:00.000Z',
    });

    assert.strictEqual(updated.call_id, 'call-2');
    assert.strictEqual(updated.attempt_count, 2);
    assert.strictEqual(updated.next_attempt_at, '2026-01-01T08:15:00.000Z');
  });

  test('throws loudly rather than silently no-opping on an unknown (medicationId, slotTime) key', async () => {
    // The acceptance criterion this task names explicitly: a write that
    // matches zero rows must throw, not carry on as if it had recorded
    // an attempt — that is how a patient gets dialled repeatedly.
    await freshDose();
    await assert.rejects(
      () =>
        repo.recordDoseAttempt(medicationId, '2099-01-01T00:00:00.000Z', {
          callId: 'call-x',
          attemptCount: 1,
          nextAttemptAt: null,
        }),
      /Unknown dose event/i
    );
  });

  test('throws on an unknown medicationId even when the slotTime matches another medication', async () => {
    await freshDose();
    await assert.rejects(
      () => repo.recordDoseAttempt(999999, slotTime, { callId: 'call-x', attemptCount: 1 }),
      /Unknown dose event/i
    );
  });
});

describe('dueDoseEvents excludes a future next_attempt_at', () => {
  let repo;
  let patientId;
  let medicationId;
  const slotTime = '2026-01-01T08:00:00.000Z';

  const freshDose = async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
    const med = await repo.upsertMedication({ ...MED, patientId });
    medicationId = med.id;
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });
  };

  test('a dose already dialled once is not due again before its retry offset elapses', async () => {
    await freshDose();
    await repo.recordDoseAttempt(medicationId, slotTime, {
      callId: 'call-1',
      attemptCount: 1,
      nextAttemptAt: '2026-01-01T08:05:00.000Z',
    });

    const tooSoon = await repo.dueDoseEvents(new Date('2026-01-01T08:02:00.000Z'));
    assert.strictEqual(tooSoon.length, 0, 'retry offset has not elapsed yet');

    const nowDue = await repo.dueDoseEvents(new Date('2026-01-01T08:05:00.000Z'));
    assert.strictEqual(nowDue.length, 1, 'retry offset has now elapsed');
    assert.strictEqual(nowDue[0].slot_time, slotTime);
  });

  test('a dose with no recorded attempt (next_attempt_at NULL) is due as soon as its slot arrives', async () => {
    await freshDose();
    const due = await repo.dueDoseEvents(new Date('2026-01-01T08:00:00.000Z'));
    assert.strictEqual(due.length, 1);
  });
});

describe('ConsoleRepository gate-column surface', () => {
  test('setPatientSchedule and recordDoseAttempt are declared no-ops, never crash', async () => {
    const repo = new ConsoleRepository();
    assert.strictEqual(
      await repo.setPatientSchedule(1, { signedOffAt: '2026-08-30T10:00:00.000Z' }),
      null
    );
    assert.strictEqual(
      await repo.recordDoseAttempt(1, 'x', { callId: 'call-1', attemptCount: 1 }),
      null
    );
  });
});
