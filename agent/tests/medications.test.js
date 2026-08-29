'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');

/**
 * medications + dose_events: the data foundation a future scheduler polls.
 *
 * No scheduler logic is tested here — only that the schema and repository
 * round-trip correctly, that duplicate writes never double-log a dose, and
 * that dueDoseEvents takes an injected clock so it's testable without
 * sleeping.
 */

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-medications-')),
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
  times: ['08:00', '20:00'],
  foodRule: 'after',
  startDate: '2026-01-01',
  endDate: null,
  active: true,
};

describe('medications', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
  });

  test('upsertMedication then listMedications round-trips', async () => {
    await repo.upsertMedication({ ...MED, patientId });
    const meds = await repo.listMedications(patientId);
    assert.strictEqual(meds.length, 1);
    assert.strictEqual(meds[0].name, 'Metformin');
    assert.strictEqual(meds[0].dose, '500mg');
    assert.strictEqual(meds[0].food_rule, 'after');
    assert.deepStrictEqual(JSON.parse(meds[0].times), ['08:00', '20:00']);
  });

  test('upsertMedication is idempotent on (patientId, name, startDate)', async () => {
    await repo.upsertMedication({ ...MED, patientId });
    await repo.upsertMedication({ ...MED, patientId, dose: '1000mg' });
    const meds = await repo.listMedications(patientId);
    assert.strictEqual(meds.length, 1, 'same regimen re-seeded must update, not duplicate');
    assert.strictEqual(meds[0].dose, '1000mg');
  });

  test('a taper — same drug, different start_date — persists as two rows', async () => {
    // A dose stepping down over time is modelled as two rows for the same
    // drug name, distinguished by start_date. Silently merging them into
    // one row would be a data-loss bug: a caregiver's app would show one
    // regimen where two actually exist.
    await repo.upsertMedication({
      ...MED,
      patientId,
      startDate: '2026-01-01',
      endDate: '2026-01-14',
      dose: '1000mg',
    });
    await repo.upsertMedication({
      ...MED,
      patientId,
      startDate: '2026-01-15',
      endDate: null,
      dose: '500mg',
    });

    const meds = await repo.listMedications(patientId);
    assert.strictEqual(meds.length, 2, 'both steps of the taper must persist');
    const doses = meds.map((m) => m.dose).sort();
    assert.deepStrictEqual(doses, ['1000mg', '500mg']);
  });

  test('upsertMedication rejects a null start_date rather than silently defaulting', async () => {
    // start_date is NOT NULL in the schema and part of the identity key, so
    // there is no ambiguous null-collapsing case: a missing start_date must
    // fail loudly rather than being coalesced into some default.
    await assert.rejects(() => repo.upsertMedication({ ...MED, patientId, startDate: null }));
  });

  test('listMedications activeOnly filters out inactive rows', async () => {
    await repo.upsertMedication({ ...MED, patientId, name: 'Metformin', active: true });
    await repo.upsertMedication({ ...MED, patientId, name: 'Old Drug', active: false });

    const all = await repo.listMedications(patientId);
    assert.strictEqual(all.length, 2);

    const active = await repo.listMedications(patientId, { activeOnly: true });
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].name, 'Metformin');
  });
});

describe('dose events', () => {
  let repo;
  let patientId;
  let medicationId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
    const med = await repo.upsertMedication({ ...MED, patientId });
    medicationId = med.id;
  });

  test('upsertDoseEvent then listDoseEvents round-trips', async () => {
    await repo.upsertDoseEvent({
      medicationId,
      patientId,
      slotTime: '2026-01-01T08:00:00.000Z',
    });
    const events = await repo.listDoseEvents({ patientId });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'pending');
  });

  test('a duplicate upsertDoseEvent for the same slot does not double-log the dose', async () => {
    // Simulates a retried or duplicated call re-issuing the same scheduled
    // dose. The UNIQUE index on (medication_id, slot_time) is what makes
    // this idempotent rather than a second row.
    const slotTime = '2026-01-01T08:00:00.000Z';
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime, status: 'pending' });
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime, status: 'pending' });

    const events = await repo.listDoseEvents({ patientId });
    assert.strictEqual(events.length, 1, 'must never double-log a dose');
  });

  test('upsertDoseEvent does not clobber a status a live call already recorded', async () => {
    const slotTime = '2026-01-01T08:00:00.000Z';
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime, status: 'pending' });
    await repo.setDoseStatus(medicationId, slotTime, 'confirmed', { actor: 'parent_on_call' });

    // A later re-run of a seed script or a retried scheduler tick that
    // doesn't specify a status must not revert a dose that was already
    // settled by a real call.
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });

    const events = await repo.listDoseEvents({ patientId });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'confirmed');
  });

  test('setDoseStatus updates status, actor, callId and confirmedAt', async () => {
    const slotTime = '2026-01-01T08:00:00.000Z';
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });
    const confirmedAt = '2026-01-01T08:05:00.000Z';

    const updated = await repo.setDoseStatus(medicationId, slotTime, 'confirmed', {
      actor: 'caregiver_in_app',
      callId: 'call-123',
      confirmedAt,
    });

    assert.strictEqual(updated.status, 'confirmed');
    assert.strictEqual(updated.actor, 'caregiver_in_app');
    assert.strictEqual(updated.call_id, 'call-123');
    assert.strictEqual(updated.confirmed_at, confirmedAt);
  });

  test('setDoseStatus rejects a status outside the allowed set', async () => {
    const slotTime = '2026-01-01T08:00:00.000Z';
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });
    await assert.rejects(
      () => repo.setDoseStatus(medicationId, slotTime, 'taken'),
      /status/i
    );
  });

  test('setDoseStatus throws loudly rather than silently no-opping on an unknown slot', async () => {
    // The hard-won lesson from save(): an UPDATE matching zero rows must
    // never look like a successful write.
    await assert.rejects(
      () => repo.setDoseStatus(medicationId, '2099-01-01T00:00:00.000Z', 'confirmed'),
      /Unknown dose event/i
    );
  });

  test('unknown status is distinct from missed', async () => {
    const slotTime = '2026-01-01T08:00:00.000Z';
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });
    const updated = await repo.setDoseStatus(medicationId, slotTime, 'unknown', {
      actor: 'parent_on_call',
    });
    assert.strictEqual(updated.status, 'unknown');
    assert.notStrictEqual(updated.status, 'missed');
  });

  test('listDoseEvents filters by status and slot_time range', async () => {
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime: '2026-01-01T08:00:00.000Z' });
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime: '2026-01-02T08:00:00.000Z' });
    await repo.setDoseStatus(medicationId, '2026-01-02T08:00:00.000Z', 'confirmed', {
      actor: 'parent_on_call',
    });

    const pending = await repo.listDoseEvents({ patientId, status: 'pending' });
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].slot_time, '2026-01-01T08:00:00.000Z');

    const ranged = await repo.listDoseEvents({
      patientId,
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
    });
    assert.strictEqual(ranged.length, 1);
    assert.strictEqual(ranged[0].slot_time, '2026-01-02T08:00:00.000Z');
  });

  test('dueDoseEvents returns pending events whose slot_time has arrived, using an injected clock', async () => {
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime: '2026-01-01T08:00:00.000Z' });
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime: '2026-01-01T20:00:00.000Z' });

    const before = await repo.dueDoseEvents(new Date('2026-01-01T07:00:00.000Z'));
    assert.strictEqual(before.length, 0, 'nothing is due yet');

    const atMorning = await repo.dueDoseEvents(new Date('2026-01-01T08:00:00.000Z'));
    assert.strictEqual(atMorning.length, 1);
    assert.strictEqual(atMorning[0].slot_time, '2026-01-01T08:00:00.000Z');

    const atNight = await repo.dueDoseEvents(new Date('2026-01-01T21:00:00.000Z'));
    assert.strictEqual(atNight.length, 2, 'both slots have now arrived');
  });

  test('dueDoseEvents excludes confirmed events', async () => {
    const slotTime = '2026-01-01T08:00:00.000Z';
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime });
    await repo.setDoseStatus(medicationId, slotTime, 'confirmed', { actor: 'parent_on_call' });

    const due = await repo.dueDoseEvents(new Date('2026-01-01T09:00:00.000Z'));
    assert.strictEqual(due.length, 0);
  });

  test('dueDoseEvents withinMinutes excludes doses overdue beyond the window', async () => {
    await repo.upsertDoseEvent({ medicationId, patientId, slotTime: '2026-01-01T08:00:00.000Z' });

    const now = new Date('2026-01-01T10:00:00.000Z');
    const bounded = await repo.dueDoseEvents(now, { withinMinutes: 30 });
    assert.strictEqual(bounded.length, 0, '2 hours overdue is outside a 30-minute window');

    const unbounded = await repo.dueDoseEvents(now);
    assert.strictEqual(unbounded.length, 1, 'no window means still due');
  });
});

describe('ConsoleRepository medication/dose-event surface', () => {
  test('never throws on the medication and dose-event methods', async () => {
    const repo = new ConsoleRepository();
    await repo.upsertMedication({ patientId: 1, name: 'Metformin' });
    assert.deepStrictEqual(await repo.listMedications(1), []);
    await repo.upsertDoseEvent({ medicationId: 1, patientId: 1, slotTime: 'x' });
    await repo.setDoseStatus(1, 'x', 'confirmed');
    assert.deepStrictEqual(await repo.listDoseEvents({ patientId: 1 }), []);
    assert.deepStrictEqual(await repo.dueDoseEvents(new Date()), []);
  });
});
