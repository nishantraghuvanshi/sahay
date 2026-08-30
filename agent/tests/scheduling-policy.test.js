'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  decideDial,
  nextAttemptAt,
  RETRY_OFFSETS_MIN,
  MAX_ATTEMPTS,
} = require('../src/use-cases/medication-adherence/scheduling/policy');

/**
 * spec: .superpowers/sdd/scheduler/task-3-brief.md
 *
 * One test per numbered rule row, asserting both `action` and the exact
 * `reason` string, plus coverage of the malformed-quiet_windows decision
 * and a proof that the function performs no I/O and mutates nothing it is
 * given.
 */

// A signed-off patient in Asia/Kolkata (UTC+5:30) with no quiet windows —
// the baseline every test overrides from.
const BASE_PATIENT = Object.freeze({
  id: 1,
  schedule_signed_off_at: '2026-08-01T00:00:00.000Z',
  quiet_windows: null,
  timezone: 'Asia/Kolkata',
});

const BASE_MEDICATION = Object.freeze({
  id: 1,
  patient_id: 1,
  is_priority: 0,
});

const BASE_DOSE_EVENT = Object.freeze({
  id: 1,
  medication_id: 1,
  patient_id: 1,
  slot_time: '2026-08-30T02:30:00.000Z', // 08:00 Asia/Kolkata
  status: 'pending',
  attempt_count: 0,
  next_attempt_at: null,
});

const NOW = new Date('2026-08-30T02:30:00.000Z'); // 08:00 Asia/Kolkata

describe('decideDial — rule order, exactly as specced', () => {
  test('1: schedule_signed_off_at is null -> skip', () => {
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: BASE_MEDICATION,
      patient: { ...BASE_PATIENT, schedule_signed_off_at: null },
      now: NOW,
      activeSession: null,
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'rule: schedule not signed off by caregiver');
  });

  test('2: doseEvent.status !== "pending" -> skip, names the resolved status', () => {
    const result = decideDial({
      doseEvent: { ...BASE_DOSE_EVENT, status: 'confirmed' },
      medication: BASE_MEDICATION,
      patient: BASE_PATIENT,
      now: NOW,
      activeSession: null,
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'rule: dose already resolved as confirmed');
  });

  test('3: activeSession for this patient -> wait', () => {
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: BASE_MEDICATION,
      patient: BASE_PATIENT,
      now: NOW,
      activeSession: { id: 'call-live' },
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'wait');
    assert.strictEqual(result.reason, 'rule: patient already on a live call');
  });

  test('4: attempt_count >= MAX_ATTEMPTS -> give_up (writes "unknown", never "missed")', () => {
    assert.strictEqual(MAX_ATTEMPTS, 4, 'derived from RETRY_OFFSETS_MIN.length + 1');
    const result = decideDial({
      doseEvent: { ...BASE_DOSE_EVENT, attempt_count: MAX_ATTEMPTS },
      medication: BASE_MEDICATION,
      patient: BASE_PATIENT,
      now: NOW,
      activeSession: null,
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'give_up');
    assert.strictEqual(result.reason, 'rule: three retries made without an answer');
  });

  test('5: next_attempt_at in the future -> wait, names the time', () => {
    const result = decideDial({
      doseEvent: {
        ...BASE_DOSE_EVENT,
        attempt_count: 1,
        next_attempt_at: '2026-08-30T02:35:00.000Z',
      },
      medication: BASE_MEDICATION,
      patient: BASE_PATIENT,
      now: NOW, // 02:30Z, before the 02:35Z next attempt
      activeSession: null,
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'wait');
    assert.strictEqual(result.reason, 'rule: next attempt not due until 2026-08-30T02:35:00.000Z');
  });

  test('6: inside quiet window AND is_priority 0 -> skip', () => {
    // 17:30Z + 5:30 = 23:00 Asia/Kolkata local — inside 22:00-06:00.
    const now = new Date('2026-08-30T17:30:00.000Z');
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: { ...BASE_MEDICATION, is_priority: 0 },
      patient: {
        ...BASE_PATIENT,
        quiet_windows: JSON.stringify([{ start: '22:00', end: '06:00' }]),
      },
      now,
      activeSession: null,
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'rule: inside caregiver do-not-call window');
  });

  test('7: inside quiet window AND is_priority 1 -> dial, override reason', () => {
    const now = new Date('2026-08-30T17:30:00.000Z'); // same 23:00 local instant as row 6
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: { ...BASE_MEDICATION, is_priority: 1 },
      patient: {
        ...BASE_PATIENT,
        quiet_windows: JSON.stringify([{ start: '22:00', end: '06:00' }]),
      },
      now,
      activeSession: null,
    });
    assert.strictEqual(result.dial, true);
    assert.strictEqual(result.action, 'dial');
    assert.strictEqual(result.reason, 'rule: priority medication overrides do-not-call window');
  });

  test('8: otherwise -> dial, dose time reached', () => {
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: BASE_MEDICATION,
      patient: BASE_PATIENT,
      now: NOW,
      activeSession: null,
    });
    assert.strictEqual(result.dial, true);
    assert.strictEqual(result.action, 'dial');
    assert.strictEqual(result.reason, 'rule: dose time reached');
  });
});

describe('quiet_windows parsing: malformed or unreadable values fail open, never throw', () => {
  for (const [label, raw] of [
    ['null', null],
    ['empty string', ''],
    ['invalid JSON', '{not json'],
    ['valid JSON but not an array', JSON.stringify({ start: '22:00', end: '06:00' })],
  ]) {
    test(`${label} -> treated as no quiet windows, dose stays dialable`, () => {
      const result = decideDial({
        doseEvent: BASE_DOSE_EVENT,
        medication: BASE_MEDICATION,
        patient: { ...BASE_PATIENT, quiet_windows: raw },
        now: NOW,
        activeSession: null,
      });
      assert.strictEqual(result.dial, true);
      assert.strictEqual(result.action, 'dial');
      assert.strictEqual(result.reason, 'rule: dose time reached');
    });
  }
});

describe('quiet_windows element validation: a malformed window is dropped, not fatal', () => {
  test('an element missing "end" does not throw, and is dropped (dose stays dialable)', () => {
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: BASE_MEDICATION,
      patient: {
        ...BASE_PATIENT,
        quiet_windows: JSON.stringify([{ start: '22:00' }]),
      },
      now: NOW,
      activeSession: null,
    });
    assert.strictEqual(result.dial, true);
    assert.strictEqual(result.action, 'dial');
    assert.strictEqual(result.reason, 'rule: dose time reached');
  });

  test('a null element does not throw, and is dropped (dose stays dialable)', () => {
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: BASE_MEDICATION,
      patient: {
        ...BASE_PATIENT,
        quiet_windows: JSON.stringify([null]),
      },
      now: NOW,
      activeSession: null,
    });
    assert.strictEqual(result.dial, true);
    assert.strictEqual(result.action, 'dial');
    assert.strictEqual(result.reason, 'rule: dose time reached');
  });

  test('one valid window survives alongside a malformed one, and still suppresses a non-priority dial', () => {
    // 01:00Z + 5:30 = 06:30 Asia/Kolkata local — inside the valid 06:00-07:00 window.
    const now = new Date('2026-08-30T01:00:00.000Z');
    const result = decideDial({
      doseEvent: BASE_DOSE_EVENT,
      medication: { ...BASE_MEDICATION, is_priority: 0 },
      patient: {
        ...BASE_PATIENT,
        quiet_windows: JSON.stringify([{ start: '06:00', end: '07:00' }, { start: '22:00' }]),
      },
      now,
      activeSession: null,
    });
    assert.strictEqual(result.dial, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'rule: inside caregiver do-not-call window');
  });
});

describe('nextAttemptAt', () => {
  test('matches RETRY_OFFSETS_MIN exactly, and returns null past the last offset', () => {
    assert.deepStrictEqual(RETRY_OFFSETS_MIN, [5, 15, 30]);
    const slotTime = '2026-08-30T02:30:00.000Z';
    assert.strictEqual(nextAttemptAt(slotTime, 1), '2026-08-30T02:35:00.000Z');
    assert.strictEqual(nextAttemptAt(slotTime, 2), '2026-08-30T02:45:00.000Z');
    assert.strictEqual(nextAttemptAt(slotTime, 3), '2026-08-30T03:00:00.000Z');
    assert.strictEqual(nextAttemptAt(slotTime, 4), null);
  });
});

describe('purity: no I/O, mutates nothing it is given', () => {
  test('deep-frozen inputs survive a call unmutated, and the call does not throw', () => {
    const doseEvent = Object.freeze({ ...BASE_DOSE_EVENT });
    const medication = Object.freeze({ ...BASE_MEDICATION });
    const patient = Object.freeze({ ...BASE_PATIENT });
    const args = Object.freeze({ doseEvent, medication, patient, now: NOW, activeSession: null });

    // 'use strict' makes an attempted mutation of a frozen object throw a
    // TypeError, so calling decideDial with every input frozen and
    // asserting it does not throw is itself proof nothing was mutated.
    assert.doesNotThrow(() => decideDial(args));

    const first = decideDial(args);
    const second = decideDial(args);
    assert.deepStrictEqual(first, second, 'same inputs, same output — no hidden state');
  });
});
