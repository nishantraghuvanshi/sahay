'use strict';

/**
 * Seed Medications
 *
 * Hand-edited dose schedule for testing, until the caregiver app's OCR
 * pipeline can populate this from a real prescription. Edit SEED_PATIENTS
 * below, then run this script. It is safe to re-run: upsertMedication is
 * idempotent on (patient, name), and upsertDoseEvent is idempotent on
 * (medication, slot_time), so re-running after editing a dose or adding a
 * medication updates existing rows instead of duplicating them.
 *
 * This script only materializes rows — it does not decide who to call or
 * when. That's the scheduler's job, not this script's.
 *
 * Usage:
 *   node scripts/seed-medications.js
 *   node scripts/seed-medications.js --days=14   # dose_events look-ahead window
 */

require('dotenv').config();

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');

/**
 * Edit this by hand for each pilot patient. `times` are "HH:MM" 24h local
 * times; a dose_event is generated for each time, for each day between
 * today and the look-ahead window, while the medication is active and
 * within [startDate, endDate].
 */
const SEED_PATIENTS = [
  {
    phone: '+919876543210',
    name: 'Sharma-ji',
    medications: [
      {
        name: 'Metformin',
        dose: '500mg',
        times: ['08:00', '20:00'],
        foodRule: 'after',
        startDate: '2026-01-01',
        endDate: null,
        active: true,
      },
    ],
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

/** Same repository selection as make-call.js / server.js. */
function buildRepository() {
  const dbPath = process.env.DB_PATH || process.env.DATABASE_URL;
  return dbPath ? new SqliteRepository({ dbPath }) : new ConsoleRepository();
}

/** @returns {string} YYYY-MM-DD for a Date, in UTC. */
function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Every "HH:MM" slot, for every day from today through `days` ahead,
 * clipped to the medication's [startDate, endDate].
 * @returns {string[]} ISO-8601 slot_time values
 */
function generateSlots(med, days, now) {
  const slots = [];
  const start = med.startDate ? new Date(`${med.startDate}T00:00:00.000Z`) : null;
  const end = med.endDate ? new Date(`${med.endDate}T23:59:59.999Z`) : null;

  for (let d = 0; d < days; d++) {
    const day = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const dateOnly = toDateOnly(day);

    if (start && day < start) continue;
    if (end && day > end) continue;

    for (const time of med.times) {
      slots.push(new Date(`${dateOnly}T${time}:00.000Z`).toISOString());
    }
  }
  return slots;
}

async function main() {
  const args = parseArgs();
  const days = args.days ? parseInt(args.days, 10) : 7;
  const now = new Date();

  const repo = buildRepository();
  if (!repo.isPersistent) {
    console.log(
      JSON.stringify({
        event: 'seed_skipped_no_persistence',
        reason: 'Set DB_PATH or DATABASE_URL to seed a real database.',
      })
    );
    return;
  }

  let medicationCount = 0;
  let doseEventCount = 0;

  for (const patientSeed of SEED_PATIENTS) {
    await repo.upsertPatient({ phone: patientSeed.phone, name: patientSeed.name });
    const patient = await repo.findPatientByPhone(patientSeed.phone);

    for (const medSeed of patientSeed.medications) {
      const med = await repo.upsertMedication({ ...medSeed, patientId: patient.id });
      medicationCount++;

      if (!med.active) continue; // don't schedule doses for a discontinued medication

      const slots = generateSlots(medSeed, days, now);
      for (const slotTime of slots) {
        await repo.upsertDoseEvent({
          medicationId: med.id,
          patientId: patient.id,
          slotTime,
        });
        doseEventCount++;
      }
    }
  }

  console.log(
    JSON.stringify({
      event: 'seed_complete',
      patients: SEED_PATIENTS.length,
      medications: medicationCount,
      doseEvents: doseEventCount,
      lookaheadDays: days,
    })
  );

  await repo.close();
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'seed_failed', error: err.message }));
  process.exit(1);
});
