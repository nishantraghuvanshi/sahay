'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  collectSlots,
  nextSlotAfter,
  foodRelationForSlot,
  buildNextCallLine,
} = require('../src/use-cases/medication-adherence/scheduling/next-call');

// Shapes taken from the real `medications` rows, not invented: slots is a JSON
// string of "HH:MM" local times, with_food is one of after/before/with/any.
const MEDS = [
  { name: 'Metformin', dose: '500mg', slots: '["08:30", "21:00"]', with_food: 'after' },
  { name: 'Amlodipine', dose: '5mg', slots: '["08:30"]', with_food: 'any' },
  { name: 'Atorvastatin', dose: '10mg', slots: '["21:00"]', with_food: 'after' },
];

const MEALS = { breakfast: '08:00', lunch: '13:30', dinner: '20:30' };

describe('collectSlots', () => {
  test('merges every active medication into one sorted, de-duplicated list', () => {
    assert.deepStrictEqual(collectSlots(MEDS), ['08:30', '21:00']);
  });

  test('ignores medications that were stopped or excluded', () => {
    const meds = [
      ...MEDS,
      { name: 'Old', slots: '["12:00"]', stopped_at: '2026-08-01' },
      { name: 'Dropped', slots: '["15:00"]', excluded: 1 },
    ];
    assert.deepStrictEqual(collectSlots(meds), ['08:30', '21:00']);
  });

  test('survives a malformed slots value rather than throwing mid-call', () => {
    const meds = [{ name: 'Bad', slots: 'not json' }, MEDS[0]];
    assert.deepStrictEqual(collectSlots(meds), ['08:30', '21:00']);
  });

  test('accepts slots already parsed into an array', () => {
    assert.deepStrictEqual(collectSlots([{ slots: ['09:00', '09:00'] }]), ['09:00']);
  });

  test('returns an empty list for no medications', () => {
    assert.deepStrictEqual(collectSlots([]), []);
    assert.deepStrictEqual(collectSlots(null), []);
  });
});

describe('nextSlotAfter', () => {
  test('finds the next slot later the same day', () => {
    assert.strictEqual(nextSlotAfter(['08:30', '13:00', '21:00'], '08:30'), '13:00');
  });

  test('returns null after the last slot of the day', () => {
    // Deliberately NOT rolling on to tomorrow morning. Promising a call is a
    // promise, and nothing here knows the scheduler will still be running
    // tomorrow — see the false "I am contacting your family" defect.
    assert.strictEqual(nextSlotAfter(['08:30', '21:00'], '21:00'), null);
  });

  test('returns null when the schedule has one slot', () => {
    assert.strictEqual(nextSlotAfter(['08:30'], '08:30'), null);
  });

  test('handles a current time that is not itself a slot', () => {
    assert.strictEqual(nextSlotAfter(['08:30', '21:00'], '14:05'), '21:00');
  });

  test('returns null for an empty schedule', () => {
    assert.strictEqual(nextSlotAfter([], '08:30'), null);
  });
});

describe('foodRelationForSlot', () => {
  test('reports the relation for the medicines due at that slot', () => {
    assert.strictEqual(foodRelationForSlot(MEDS, '21:00'), 'after');
  });

  test('the strictest relation wins when medicines at one slot disagree', () => {
    // 08:30 has Metformin (after food) and Amlodipine (any). If one of them
    // needs food, the food question is worth asking.
    assert.strictEqual(foodRelationForSlot(MEDS, '08:30'), 'after');
  });

  test('returns null when nothing at that slot cares about food', () => {
    assert.strictEqual(foodRelationForSlot([{ slots: '["10:00"]', with_food: 'any' }], '10:00'), null);
  });

  test('returns null for a slot with no medicines', () => {
    assert.strictEqual(foodRelationForSlot(MEDS, '03:00'), null);
  });
});

describe('buildNextCallLine', () => {
  test('names the meal and the time when the next slot follows a meal', () => {
    const line = buildNextCallLine({ medications: MEDS, afterSlot: '08:30', mealTimes: MEALS });
    // 21:00 sits after dinner at 20:30.
    assert.match(line, /खाने के बाद/);
    assert.match(line, /9/);
    assert.match(line, /कॉल/);
  });

  test('falls back to the time of day when no meal is close to the slot', () => {
    const line = buildNextCallLine({
      medications: [{ slots: '["08:30", "16:00"]' }],
      afterSlot: '08:30',
      mealTimes: MEALS,
    });
    assert.doesNotMatch(line, /खाने के बाद/);
    assert.match(line, /शाम/);
    assert.match(line, /4/);
  });

  test('says nothing at all when there is no later dose today', () => {
    // An empty line must render as silence, not as an awkward half-sentence.
    assert.strictEqual(buildNextCallLine({ medications: MEDS, afterSlot: '21:00', mealTimes: MEALS }), '');
  });

  test('says nothing when the patient has no medications on file', () => {
    assert.strictEqual(buildNextCallLine({ medications: [], afterSlot: '08:30', mealTimes: MEALS }), '');
  });

  test('works without meal times, which many patients will not have', () => {
    const line = buildNextCallLine({ medications: MEDS, afterSlot: '08:30', mealTimes: null });
    assert.match(line, /रात/);
    assert.match(line, /9/);
    assert.doesNotMatch(line, /undefined|NaN|null/);
  });

  test('renders midday and midnight without a 0 o\'clock', () => {
    const noon = buildNextCallLine({ medications: [{ slots: '["08:00","12:00"]' }], afterSlot: '08:00', mealTimes: null });
    assert.match(noon, /12/);
    const midnight = buildNextCallLine({ medications: [{ slots: '["22:00","00:30"]' }], afterSlot: '22:00', mealTimes: null });
    // 00:30 is earlier in the day than 22:00, so there is no later dose.
    assert.strictEqual(midnight, '');
  });

  test('never contains an unresolved placeholder', () => {
    for (const afterSlot of ['08:30', '13:00', '21:00']) {
      const line = buildNextCallLine({ medications: MEDS, afterSlot, mealTimes: MEALS });
      assert.doesNotMatch(line, /\{\{|\}\}/);
    }
  });
});
