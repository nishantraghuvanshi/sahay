'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');

/**
 * findPatientById and findMedicationById: the two lookups the scheduler's
 * dose tick needs and nothing in this repository provided before it —
 * dose_events rows carry medication_id/patient_id, not the medication/patient
 * objects decideDial() needs. Existing lookups only go by phone (patients)
 * or by patientId (medications list), neither of which fits a tick that
 * starts from a dose_events row.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-repo-lookups-')),
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

describe('SqliteRepository — findPatientById', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    patientId = (await repo.findPatientByPhone(PATIENT.phone)).id;
  });

  test('returns the patient row by id', async () => {
    const patient = await repo.findPatientById(patientId);
    assert.strictEqual(patient.id, patientId);
    assert.strictEqual(patient.phone_e164, PATIENT.phone);
  });

  test('applies the same default timezone as findPatientByPhone', async () => {
    const patient = await repo.findPatientById(patientId);
    assert.strictEqual(patient.timezone, 'Asia/Kolkata');
  });

  test('returns null for an unknown id', async () => {
    const patient = await repo.findPatientById(999999);
    assert.strictEqual(patient, null);
  });
});

describe('SqliteRepository — findMedicationById', () => {
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

  test('returns the medication row by id', async () => {
    const med = await repo.findMedicationById(medicationId);
    assert.strictEqual(med.id, medicationId);
    assert.strictEqual(med.name, 'Metformin');
  });

  test('returns null for an unknown id', async () => {
    const med = await repo.findMedicationById(999999);
    assert.strictEqual(med, null);
  });
});

describe('ConsoleRepository — findPatientById / findMedicationById', () => {
  test('both resolve to null — no persistence to look anything up in', async () => {
    const repo = new ConsoleRepository();
    assert.strictEqual(await repo.findPatientById(1), null);
    assert.strictEqual(await repo.findMedicationById(1), null);
  });
});
