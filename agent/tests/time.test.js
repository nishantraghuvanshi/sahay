'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { localSlotToUtc, utcToLocalParts, isWithinLocalWindow } = require('../src/utils/time');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const { generateSlots } = require('../scripts/seed-medications');

/**
 * spec: .superpowers/sdd/scheduler/task-1-brief.md
 *
 * Covers the timezone helpers directly, plus (below) that re-seeding a
 * database created before this fix corrects the stale UTC-stamped rows
 * rather than leaving two generations of slot times side by side.
 */

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-time-')), 'test.db');
  tmpDbs.push(dbPath);
  return new SqliteRepository({ dbPath });
}

after(() => {
  for (const p of tmpDbs) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe('localSlotToUtc', () => {
  test('08:00 Asia/Kolkata is 02:30 UTC', () => {
    assert.strictEqual(
      localSlotToUtc('2026-08-30', '08:00', 'Asia/Kolkata'),
      '2026-08-30T02:30:00.000Z'
    );
  });

  test('crosses a DST transition correctly on both sides (America/New_York)', () => {
    // 2026-03-08 is when US clocks spring forward; before it New York is
    // EST (UTC-5), after it EDT (UTC-4). A hardcoded offset would get one
    // of these two right and the other wrong.
    assert.strictEqual(
      localSlotToUtc('2026-03-01', '08:00', 'America/New_York'),
      '2026-03-01T13:00:00.000Z',
      'before the transition: EST is UTC-5'
    );
    assert.strictEqual(
      localSlotToUtc('2026-03-15', '08:00', 'America/New_York'),
      '2026-03-15T12:00:00.000Z',
      'after the transition: EDT is UTC-4'
    );
  });

  test('utcToLocalParts is the inverse of localSlotToUtc', () => {
    const iso = localSlotToUtc('2026-11-01', '08:00', 'America/New_York');
    assert.deepStrictEqual(utcToLocalParts(iso, 'America/New_York'), {
      dateOnly: '2026-11-01',
      hhmm: '08:00',
    });
  });
});

describe('isWithinLocalWindow', () => {
  const WINDOW = { start: '22:00', end: '06:00' }; // crosses midnight

  test('a time after 22:00 local is inside the window', () => {
    const iso = localSlotToUtc('2026-08-30', '23:00', 'Asia/Kolkata');
    assert.strictEqual(isWithinLocalWindow(iso, WINDOW, 'Asia/Kolkata'), true);
  });

  test('a time before 06:00 local (the next calendar day) is inside the window', () => {
    const iso = localSlotToUtc('2026-08-30', '02:00', 'Asia/Kolkata');
    assert.strictEqual(isWithinLocalWindow(iso, WINDOW, 'Asia/Kolkata'), true);
  });

  test('a mid-afternoon time is outside the window', () => {
    const iso = localSlotToUtc('2026-08-30', '12:00', 'Asia/Kolkata');
    assert.strictEqual(isWithinLocalWindow(iso, WINDOW, 'Asia/Kolkata'), false);
  });

  test('both boundaries are inclusive', () => {
    assert.strictEqual(
      isWithinLocalWindow(localSlotToUtc('2026-08-30', '22:00', 'Asia/Kolkata'), WINDOW, 'Asia/Kolkata'),
      true
    );
    assert.strictEqual(
      isWithinLocalWindow(localSlotToUtc('2026-08-30', '06:00', 'Asia/Kolkata'), WINDOW, 'Asia/Kolkata'),
      true
    );
  });
});

describe('re-seeding corrects stale UTC-stamped rows', () => {
  const MED = {
    name: 'Metformin',
    dose: '500mg',
    times: ['08:00'],
    foodRule: 'after',
    startDate: '2026-08-01',
    endDate: null,
    active: true,
  };

  test('a slot seeded under the pre-fix bug is removed and replaced, not duplicated', async () => {
    const repo = freshRepo();
    await repo.upsertPatient({ phone: '+919876543210', name: 'Sharma-ji' });
    const patient = await repo.findPatientByPhone('+919876543210');
    assert.strictEqual(patient.timezone, 'Asia/Kolkata', 'default applied at the read site');

    const med = await repo.upsertMedication({ ...MED, patientId: patient.id });

    // Injected clock — no Date.now() read anywhere in this test.
    const now = new Date('2026-08-30T00:00:00.000Z');
    const [{ slotTime, legacySlotTime }] = generateSlots(MED, 1, now, patient.timezone);
    assert.strictEqual(legacySlotTime, '2026-08-30T08:00:00.000Z');
    assert.strictEqual(slotTime, '2026-08-30T02:30:00.000Z');
    assert.notStrictEqual(legacySlotTime, slotTime);

    // Simulate a database seeded before the fix: the row sits at the
    // buggy (local time stamped as UTC) slot_time.
    await repo.upsertDoseEvent({
      medicationId: med.id,
      patientId: patient.id,
      slotTime: legacySlotTime,
    });

    // What a corrected re-seed does for this slot: remove the stale
    // pending row, then upsert the corrected one.
    const removed = await repo.deleteStalePendingDoseEvent(med.id, legacySlotTime);
    assert.strictEqual(removed, true);
    await repo.upsertDoseEvent({ medicationId: med.id, patientId: patient.id, slotTime });

    const rows = await repo.listDoseEvents({ patientId: patient.id });
    assert.strictEqual(rows.length, 1, 'the stale row must not survive alongside the corrected one');
    assert.strictEqual(rows[0].slot_time, slotTime);

    await repo.close();
  });

  test('running the correction twice is a no-op the second time', async () => {
    const repo = freshRepo();
    await repo.upsertPatient({ phone: '+919876543210', name: 'Sharma-ji' });
    const patient = await repo.findPatientByPhone('+919876543210');
    const med = await repo.upsertMedication({ ...MED, patientId: patient.id });

    const now = new Date('2026-08-30T00:00:00.000Z');
    const [{ slotTime, legacySlotTime }] = generateSlots(MED, 1, now, patient.timezone);

    // First pass, starting from a clean (never-buggy) database: no legacy
    // row exists, so the delete is a no-op, and the correct row is seeded.
    assert.strictEqual(await repo.deleteStalePendingDoseEvent(med.id, legacySlotTime), false);
    await repo.upsertDoseEvent({ medicationId: med.id, patientId: patient.id, slotTime });

    // Second pass — the idempotent re-seed itself — must not duplicate or
    // remove the already-correct row.
    assert.strictEqual(await repo.deleteStalePendingDoseEvent(med.id, legacySlotTime), false);
    await repo.upsertDoseEvent({ medicationId: med.id, patientId: patient.id, slotTime });

    const rows = await repo.listDoseEvents({ patientId: patient.id });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].slot_time, slotTime);

    await repo.close();
  });

  test('a confirmed dose at the stale slot_time is never deleted by the cleanup', async () => {
    const repo = freshRepo();
    await repo.upsertPatient({ phone: '+919876543210', name: 'Sharma-ji' });
    const patient = await repo.findPatientByPhone('+919876543210');
    const med = await repo.upsertMedication({ ...MED, patientId: patient.id });

    const now = new Date('2026-08-30T00:00:00.000Z');
    const [{ legacySlotTime }] = generateSlots(MED, 1, now, patient.timezone);

    await repo.upsertDoseEvent({
      medicationId: med.id,
      patientId: patient.id,
      slotTime: legacySlotTime,
    });
    // The patient was actually asked about this (wrong-time) dose and
    // confirmed it — that's call history, not a placeholder to be scrubbed.
    await repo.setDoseStatus(med.id, legacySlotTime, 'confirmed', { actor: 'patient' });

    const removed = await repo.deleteStalePendingDoseEvent(med.id, legacySlotTime);
    assert.strictEqual(removed, false, 'a confirmed row must survive the stale-row cleanup');

    const rows = await repo.listDoseEvents({ patientId: patient.id });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'confirmed');

    await repo.close();
  });
});
