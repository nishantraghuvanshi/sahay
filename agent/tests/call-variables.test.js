'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  buildScheduleVariables,
} = require('../src/use-cases/medication-adherence/scheduling/call-variables');

const PATIENT = {
  id: 'p1',
  meal_times: '{"breakfast": "08:00", "lunch": "13:30", "dinner": "20:30"}',
};

const MEDS = [
  { name: 'Metformin', slots: '["08:30", "21:00"]', with_food: 'after' },
  { name: 'Amlodipine', slots: '["08:30"]', with_food: 'any' },
];

function repo({ patient = PATIENT, medications = MEDS, throws = null } = {}) {
  return {
    async findPatientByPhone() {
      if (throws === 'patient') throw new Error('db gone');
      return patient;
    },
    async findMedicationsForPatient() {
      if (throws === 'meds') throw new Error('db gone');
      return medications;
    },
  };
}

describe('buildScheduleVariables', () => {
  test('builds both lines from the patient own schedule', async () => {
    const v = await buildScheduleVariables({ repository: repo(), phone: '+91', slot: '08:30' });
    assert.match(v.next_call_line, /कॉल करूँगी/);
    assert.match(v.next_call_line, /खाने के बाद/); // 21:00 follows dinner at 20:30
    assert.strictEqual(v.food_line, 'यह दवाई खाने के बाद लेनी होती है।');
  });

  test('says nothing about a next call after the last dose of the day', async () => {
    const v = await buildScheduleVariables({ repository: repo(), phone: '+91', slot: '21:00' });
    assert.strictEqual(v.next_call_line, '');
    // The food instruction still applies to the dose being discussed.
    assert.strictEqual(v.food_line, 'यह दवाई खाने के बाद लेनी होती है।');
  });

  test('no food line when nothing at that slot cares about food', async () => {
    const v = await buildScheduleVariables({
      repository: repo({ medications: [{ slots: '["10:00","18:00"]', with_food: 'any' }] }),
      phone: '+91',
      slot: '10:00',
    });
    assert.strictEqual(v.food_line, '');
    assert.strictEqual(v.food_question, '', 'no rule means no question either');
    assert.match(v.next_call_line, /कॉल करूँगी/);
  });

  test('an unknown caller yields empty strings, not undefined', async () => {
    const v = await buildScheduleVariables({
      repository: repo({ patient: null }),
      phone: '+91',
      slot: '08:30',
    });
    assert.deepStrictEqual(v, { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' });
  });

  test('a patient with no medications on file promises nothing', async () => {
    const v = await buildScheduleVariables({
      repository: repo({ medications: [] }),
      phone: '+91',
      slot: '08:30',
    });
    assert.deepStrictEqual(v, { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' });
  });

  test('a database failure loses the lines, never the call', async () => {
    for (const throws of ['patient', 'meds']) {
      const v = await buildScheduleVariables({
        repository: repo({ throws }),
        phone: '+91',
        slot: '08:30',
      });
      assert.deepStrictEqual(v, { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' }, `throws=${throws}`);
    }
  });

  test('a repository with no database (console) yields empty strings', async () => {
    const consoleRepo = {
      async findPatientByPhone() { return null; },
      async findMedicationsForPatient() { return []; },
    };
    const v = await buildScheduleVariables({ repository: consoleRepo, phone: '+91', slot: '08:30' });
    assert.deepStrictEqual(v, { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' });
  });

  test('missing slot or phone yields empty strings rather than guessing', async () => {
    assert.deepStrictEqual(
      await buildScheduleVariables({ repository: repo(), phone: '+91' }),
      { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' }
    );
    assert.deepStrictEqual(
      await buildScheduleVariables({ repository: repo(), slot: '08:30' }),
      { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' }
    );
    assert.deepStrictEqual(await buildScheduleVariables({}), { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' });
  });

  test('never returns a value containing an unresolved placeholder', async () => {
    const v = await buildScheduleVariables({ repository: repo(), phone: '+91', slot: '08:30' });
    for (const [k, val] of Object.entries(v)) {
      assert.strictEqual(typeof val, 'string', `${k} must be a string`);
      assert.doesNotMatch(val, /\{\{|\}\}|undefined|null|NaN/, k);
    }
  });
});

describe('deriving the slot from the clock', () => {
  const repo = {
    async findPatientByPhone() {
      return { id: 'p1', meal_times: '{"dinner": "20:30"}' };
    },
    async findMedicationsForPatient() {
      return [{ slots: '["08:30", "21:00"]', with_food: 'after' }];
    },
  };

  test('a call at 08:45 is about the 08:30 dose', async () => {
    const v = await buildScheduleVariables({ repository: repo, phone: '+91', nowHHMM: '08:45' });
    assert.strictEqual(v.food_line, 'यह दवाई खाने के बाद लेनी होती है।');
    assert.match(v.food_question, /खाना खा लिया/);
    assert.match(v.next_call_line, /9 बजे/); // the 21:00 dose still ahead
  });

  test('a call at 21:10 is about the last dose, so promises no further call', async () => {
    const v = await buildScheduleVariables({ repository: repo, phone: '+91', nowHHMM: '21:10' });
    assert.strictEqual(v.next_call_line, '');
    assert.strictEqual(v.food_line, 'यह दवाई खाने के बाद लेनी होती है।');
  });

  test('before the first dose there is no slot, so no food claim is made', async () => {
    const v = await buildScheduleVariables({ repository: repo, phone: '+91', nowHHMM: '06:00' });
    assert.strictEqual(v.food_line, '');
    // The 08:30 dose is genuinely ahead, so a next call can still be promised.
    assert.match(v.next_call_line, /8 बजे/);
  });

  test('an explicit slot beats the clock', async () => {
    const v = await buildScheduleVariables({
      repository: repo, phone: '+91', slot: '21:00', nowHHMM: '08:45',
    });
    assert.strictEqual(v.next_call_line, '');
  });
});
