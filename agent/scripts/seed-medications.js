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
const { localSlotToUtc } = require('../src/utils/time');

/**
 * Edit this by hand for each pilot patient. `times` are "HH:MM" 24h local
 * times; a dose_event is generated for each time, for each day between
 * today and the look-ahead window, while the medication is active and
 * within [startDate, endDate].
 */
// Phone numbers come from the environment with placeholder defaults. Real test
// numbers previously sat in this file, which is tracked and ships in a repo that
// becomes public at submission (NFR-7). Set SEED_PATIENT_PHONE /
// SEED_PATIENT_PHONE_2 in .env (gitignored) to seed against your own handset.
const SEED_PATIENTS = [
  {
    phone: process.env.SEED_PATIENT_PHONE || '+15551230001',
    name: 'Anmol',
    drugName: 'Metformin',
    language: 'hi',
    caregiverName: 'Shubh',
    caregiverPhone: '+919876500000',
    timezone: 'Asia/Kolkata',
    notes: 'Verified Twilio caller ID — live outbound test.',
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
  {
    phone: process.env.SEED_PATIENT_PHONE_2 || '+15551230002',
    name: 'Anmol',
    drugName: 'Metformin',
    language: 'hi',
    caregiverName: 'Shubh',
    caregiverPhone: '+919876500000',
    timezone: 'Asia/Kolkata',
    notes: 'Live inbound test — own phone, consented.',
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
  {
    phone: '+919876543210',
    // The prompt appends 'जी'; do not bake the honorific into the name.
    name: 'Sharma',
    // Every variable the prompt interpolates. Left null, drug_name renders as
    // an empty string and caregiver_name falls back to the generic
    // "आपके परिवार" — which is why a seeded call sounded oddly impersonal.
    drugName: 'Metformin',
    language: 'hi',
    caregiverName: 'Shubh',
    caregiverPhone: '+919876500000',
    timezone: 'Asia/Kolkata',
    notes: 'Pilot test patient. Team phone only.',
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

/**
 * Same repository selection as server.js, VOXIKIN_DB included.
 *
 * It was missing here, so seeding silently no-opped against the shared
 * database that everything else reads — the script reported success-shaped
 * output while writing nothing. DB_PATH and DATABASE_URL keep precedence
 * because they are set per invocation; VOXIKIN_DB is the shared product
 * database and usually comes from .env.
 */
function buildRepository() {
  const dbPath =
    process.env.DB_PATH || process.env.DATABASE_URL || process.env.VOXIKIN_DB;
  return dbPath ? new SqliteRepository({ dbPath }) : new ConsoleRepository();
}

/** @returns {string} YYYY-MM-DD for a Date, in UTC. */
function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Every "HH:MM" slot, for every day from today through `days` ahead,
 * clipped to the medication's [startDate, endDate]. Each slot is computed
 * through localSlotToUtc with the patient's own timezone — med.times are
 * local wall-clock strings, not UTC.
 *
 * Each entry also carries legacySlotTime: the value the pre-fix formula
 * (`new Date(\`${dateOnly}T${time}:00.000Z\`)`, which stamped the local
 * time directly as UTC) would have produced for the same slot. main() uses
 * it to find and remove the stale row a database seeded before this fix
 * left behind, since the corrected slotTime is a different string and so
 * lands as a new row under the (medication_id, slot_time) unique index
 * rather than overwriting the old one.
 *
 * @returns {{slotTime: string, legacySlotTime: string}[]}
 */
function generateSlots(med, days, now, timeZone) {
  const slots = [];
  const start = med.startDate ? new Date(`${med.startDate}T00:00:00.000Z`) : null;
  const end = med.endDate ? new Date(`${med.endDate}T23:59:59.999Z`) : null;

  for (let d = 0; d < days; d++) {
    const day = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const dateOnly = toDateOnly(day);

    if (start && day < start) continue;
    if (end && day > end) continue;

    for (const time of med.times) {
      slots.push({
        slotTime: localSlotToUtc(dateOnly, time, timeZone),
        legacySlotTime: `${dateOnly}T${time}:00.000Z`,
      });
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
        reason: 'Set VOXIKIN_DB, DB_PATH or DATABASE_URL to seed a real database.',
      })
    );
    return;
  }

  let medicationCount = 0;
  let doseEventCount = 0;
  let staleRowsRemoved = 0;

  for (const patientSeed of SEED_PATIENTS) {
          await repo.upsertPatient({
        phone: patientSeed.phone,
        name: patientSeed.name,
        drugName: patientSeed.drugName,
        language: patientSeed.language,
        caregiverName: patientSeed.caregiverName,
        caregiverPhone: patientSeed.caregiverPhone,
        notes: patientSeed.notes,
      });
    const patient = await repo.findPatientByPhone(patientSeed.phone);

    for (const medSeed of patientSeed.medications) {
      const med = await repo.upsertMedication({ ...medSeed, patientId: patient.id });
      medicationCount++;

      if (!med.active) continue; // don't schedule doses for a discontinued medication

      const slots = generateSlots(medSeed, days, now, patient.timezone);
      for (const { slotTime, legacySlotTime } of slots) {
        // A database seeded before this fix has a pending row at
        // legacySlotTime for this same local slot — remove it so the
        // corrected row is the only one, not a second generation sitting
        // alongside it. No-op (returns false) on a database that never
        // had the bug, or on a re-run of this same corrected seed.
        if (legacySlotTime !== slotTime) {
          const removed = await repo.deleteStalePendingDoseEvent(med.id, legacySlotTime);
          if (removed) staleRowsRemoved++;
        }

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
      staleRowsRemoved,
      medications: medicationCount,
      doseEvents: doseEventCount,
      lookaheadDays: days,
    })
  );

  await repo.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: 'seed_failed', error: err.message }));
    process.exit(1);
  });
}

module.exports = { generateSlots, buildRepository, toDateOnly, main };
