'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const { resolveInboundCall } = require('../src/core/inbound/resolve-caller');
const {
  buildInboundVariables,
  INTAKE_FIELDS,
} = require('../src/use-cases/medication-adherence/inbound-context');

/**
 * Inbound resolution — what happens between the phone ringing and the
 * agent's first word.
 *
 * Vapi allows 7.5 seconds for assistant-request, so everything here is a
 * deterministic read. No model call belongs on this path.
 */

const tmpDirs = [];

function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-inbound-'));
  tmpDirs.push(dir);
  return new SqliteRepository({ dbPath: path.join(dir, 'test.db') });
}

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const KNOWN = {
  phone: '+919876543210',
  name: 'Sharma-ji',
  drugName: 'Crocin',
  language: 'hi',
  caregiverName: 'Rohan',
};

describe('unknown caller', () => {
  let repo;
  beforeEach(() => {
    repo = freshRepo();
  });

  test('is answered in inbound mode, not refused', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: '+910000000001' });
    assert.strictEqual(r.mode, 'inbound');
  });

  test('gets a patient record created so the next call already knows them', async () => {
    await resolveInboundCall({ repository: repo, phone: '+910000000001' });
    const patient = await repo.findPatientByPhone('+910000000001');
    assert.ok(patient, 'a record should now exist');
    assert.strictEqual(patient.phone_e164, '+910000000001');
  });

  test('is flagged as new, so the prompt does not pretend to know them', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: '+910000000001' });
    assert.strictEqual(r.isNewPatient, true);
  });

  test('produces an empty context line rather than a dangling placeholder', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: '+910000000001' });
    const vars = buildInboundVariables(r, 'hi');
    assert.strictEqual(vars.context_line, '');
    assert.ok(!/\{[a-z_]+\}/.test(vars.context_line));
  });

  test('a second call from that number is no longer new', async () => {
    await resolveInboundCall({ repository: repo, phone: '+910000000001' });
    const second = await resolveInboundCall({ repository: repo, phone: '+910000000001' });
    assert.strictEqual(second.isNewPatient, false);
  });

  test('a missing phone number still resolves rather than throwing', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: null });
    assert.strictEqual(r.mode, 'inbound');
    assert.strictEqual(r.patient, null, 'must not invent a record for an unknown number');
  });
});

describe('known caller, no open session', () => {
  let repo;
  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(KNOWN);
  });

  test('resolves to inbound mode', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.mode, 'inbound');
    assert.strictEqual(r.isNewPatient, false);
  });

  test('carries the patient record through', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.patient.name, 'Sharma-ji');
  });

  test('variables name the patient and their caregiver', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'hi');
    assert.strictEqual(vars.parent_name, 'Sharma-ji');
    assert.strictEqual(vars.drug_name, 'Crocin');
    assert.strictEqual(vars.caregiver_name, 'Rohan');
  });

  test('context line references prior history when there is some', async () => {
    await repo.save({
      callId: 'c1',
      label: 'ESCALATED_SYMPTOM',
      reason: 'chest discomfort',
      phone: KNOWN.phone,
    });
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'hi');
    assert.ok(vars.context_line.length > 0, 'a returning caller should be recognised');
  });
});

describe('known caller with a dropped session in the window', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(KNOWN);
    patientId = (await repo.findPatientByPhone(KNOWN.phone)).id;
    await repo.createSession({
      sessionId: 's1',
      patientId,
      callId: 'c1',
      direction: 'inbound',
    });
    await repo.updateSessionFields('s1', { chief_complaint: 'सीने में दर्द' });
    await repo.endSession('s1', 'dropped');
  });

  test('resolves to resume mode', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.mode, 'resume');
    assert.strictEqual(r.session.session_id, 's1');
  });

  test('carries the fields already captured', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.fieldsSoFar.chief_complaint, 'सीने में दर्द');
  });

  test('the summary states what is already held, verbatim', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'hi');
    assert.ok(
      vars.fields_summary.includes('सीने में दर्द'),
      'the complaint must be repeated back exactly as said'
    );
  });

  test('the next question is the first field still missing', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'hi');
    const firstMissing = INTAKE_FIELDS.find((f) => f.key !== 'chief_complaint');
    assert.strictEqual(vars.missing_field, firstMissing.hi);
  });

  test('falls back to inbound once the window has passed', async () => {
    const later = new Date(Date.now() + 20 * 60_000);
    const r = await resolveInboundCall({
      repository: repo,
      phone: KNOWN.phone,
      resumeWindowMinutes: 15,
      now: later,
    });
    assert.strictEqual(r.mode, 'inbound', 'a stale session must not resume');
  });

  test('a completed session never resumes', async () => {
    // s1 is the only session; completing it must leave nothing resumable.
    // (Creating a second session here would not test this — the dropped s1
    // would still be legitimately resumable, and rightly so.)
    await repo.endSession('s1', 'completed');
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.mode, 'inbound');
  });
});

describe('a dropped session with nothing captured (C1)', () => {
  let repo;
  let patientId;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(KNOWN);
    patientId = (await repo.findPatientByPhone(KNOWN.phone)).id;
    await repo.createSession({
      sessionId: 's1',
      patientId,
      callId: 'c1',
      direction: 'inbound',
    });
    // No updateSessionFields call: fields_so_far stays '{}', the exact shape
    // of a call that rang unanswered and was never actually spoken to.
    await repo.endSession('s1', 'dropped');
  });

  test('resolves to inbound, not resume, so the opener never claims a conversation that never happened', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.mode, 'inbound');
  });

  test('one populated field is enough to resolve to resume', async () => {
    await repo.updateSessionFields('s1', { chief_complaint: 'सीने में दर्द' });
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    assert.strictEqual(r.mode, 'resume');
  });
});

describe('resume with every field captured', () => {
  let repo;

  beforeEach(async () => {
    repo = freshRepo();
    await repo.upsertPatient(KNOWN);
    const patientId = (await repo.findPatientByPhone(KNOWN.phone)).id;
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    const all = Object.fromEntries(INTAKE_FIELDS.map((f) => [f.key, 'x']));
    await repo.updateSessionFields('s1', all);
    await repo.endSession('s1', 'dropped');
  });

  test('missing_field is empty rather than a stray placeholder', async () => {
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'hi');
    assert.strictEqual(vars.missing_field, '');
  });
});

describe('language selection', () => {
  test('English variables use English field labels', async () => {
    const repo = freshRepo();
    await repo.upsertPatient({ ...KNOWN, language: 'en' });
    const patientId = (await repo.findPatientByPhone(KNOWN.phone)).id;
    await repo.createSession({ sessionId: 's1', patientId, callId: 'c1', direction: 'inbound' });
    await repo.endSession('s1', 'dropped');

    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'en');
    assert.strictEqual(vars.missing_field, INTAKE_FIELDS[0].en);
  });
});

describe('greeting an unnamed caller reads naturally', () => {
  const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

  test('Hindi does not double the honorific', async () => {
    // "नमस्ते जी जी।" — the fallback name was जी and the template appends जी.
    const repo = freshRepo();
    const r = await resolveInboundCall({ repository: repo, phone: '+910000000009' });
    const vars = buildInboundVariables(r, 'hi');
    const msg = new MedicationAdherenceStrategy('hi').buildFirstMessage(vars, 'inbound');

    assert.ok(!/जी\s+जी/.test(msg), `honorific doubled: ${msg}`);
    assert.ok(!/ {2,}/.test(msg), `collapsed placeholder left double spaces: ${msg}`);
  });

  // Skipped by the prompt version guard, not by choice: strategy.js refuses to
  // load a language whose prompt trails the maintained one, and English is ten
  // versions behind. The assertion is still right and should be unskipped the
  // moment medication-adherence-en.yaml is ported — at which point the guard
  // stops throwing and this needs no other change.
  test.skip('English greets an unnamed caller without a dangling gap', async () => {
    const repo = freshRepo();
    const r = await resolveInboundCall({ repository: repo, phone: '+910000000009' });
    const vars = buildInboundVariables(r, 'en');
    const msg = new MedicationAdherenceStrategy('en').buildFirstMessage(vars, 'inbound');

    assert.ok(!/ {2,}/.test(msg), `double space in: ${msg}`);
    assert.ok(!/\s+[.,]/.test(msg), `space before punctuation in: ${msg}`);
  });

  test('a named caller is still addressed by name', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(KNOWN);
    const r = await resolveInboundCall({ repository: repo, phone: KNOWN.phone });
    const vars = buildInboundVariables(r, 'hi');
    const msg = new MedicationAdherenceStrategy('hi').buildFirstMessage(vars, 'inbound');
    assert.ok(msg.includes('Sharma-ji'));
  });
});
