'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const { chooseDestination } = require('../src/core/squad/router');

/**
 * Walk whole calls through the graph.
 *
 * The other squad tests assert structural properties — guardrails present,
 * everything reachable, no dead ends. None of them answers the question that
 * actually matters: does a real call get from "नमस्ते" to a recorded outcome?
 *
 * A graph can satisfy every structural check and still be unwalkable, because
 * the router is what turns edges into a path. These drive the real router with
 * a scripted model so a path is exercised end to end, without a phone.
 */

const VARS = { parent_name: 'रोहन', drug_name: 'Crocin', caregiver_name: 'शुभ' };

/** An LLM stand-in that replies with whatever the script says next. */
function scriptedRouter(replies) {
  const queue = [...replies];
  return { chatCompletion: async () => ({ content: queue.shift() ?? 'STAY' }) };
}

/**
 * Drive the graph from the entry member using scripted routing decisions.
 * Returns the sequence of member keys the call passed through.
 */
async function walk(foodRule, replies) {
  const members = new MedicationAdherenceStrategy().buildSquadMembers({ ...VARS, food_rule: foodRule });
  const byKey = new Map(members.map((m) => [m.key, m]));
  const llmAdapter = scriptedRouter(replies);

  let current = members.find((m) => m.first);
  const path = [current.key];

  for (let turn = 0; turn < 20 && !current.terminal; turn += 1) {
    const next = await chooseDestination({
      llmAdapter, llmConfig: {}, env: {}, member: current, messages: [],
    });
    if (!next) continue;
    current = byKey.get(next);
    path.push(current.key);
  }
  return { path, ended: current.terminal, final: current.key };
}

describe('a call reaches an outcome', () => {
  test('after-food, patient has eaten and already taken the dose', async () => {
    const { path, ended } = await walk('after', [
      'disclose', 'meal_check', 'dose_check_after', 'wellbeing', 'close',
    ]);
    assert.deepStrictEqual(path, ['greeting', 'disclose', 'meal_check', 'dose_check_after', 'wellbeing', 'close']);
    assert.ok(ended, 'the call must reach a terminal member');
  });

  test('after-food, patient has not eaten — no dosing instruction is given', async () => {
    const { path, final } = await walk('after', [
      'disclose', 'meal_check', 'callback_meal', 'wellbeing', 'close',
    ]);
    assert.ok(path.includes('callback_meal'), 'the not-yet-eaten path must be walkable');
    assert.ok(!path.includes('dose_check_after'), 'a dose must not be asked for before the meal');
    assert.strictEqual(final, 'close');
  });

  test('patient takes the dose during the call', async () => {
    const { path, final } = await walk('after', [
      'disclose', 'meal_check', 'dose_check_after', 'stay_on_line', 'wellbeing', 'close',
    ]);
    assert.ok(path.includes('stay_on_line'), 'the wait-on-the-line path must be walkable');
    assert.strictEqual(final, 'close');
  });

  test('before-food, already eaten — reaches the missed-window state, not a dose instruction', async () => {
    const { path, final } = await walk('before', [
      'disclose', 'dose_check_before', 'timing_mismatch', 'wellbeing', 'close',
    ]);
    assert.ok(path.includes('timing_mismatch'));
    assert.ok(!path.includes('stay_on_line'), 'a missed before-food window must not become "take it now"');
    assert.strictEqual(final, 'close');
  });

  test('refusal still reaches a recorded outcome', async () => {
    // A patient who declines must still get a wellbeing check and a close —
    // refusing a dose is not a reason to hang up on someone.
    const { path, final } = await walk(null, ['disclose', 'dose_check', 'refusal', 'wellbeing', 'close']);
    assert.deepStrictEqual(path.slice(-2), ['wellbeing', 'close']);
    assert.strictEqual(final, 'close');
  });
});

describe('an emergency ends the call wherever it happens', () => {
  // The single-prompt design relied on "never return to the medication
  // reminder" being obeyed. Here it is a property of the graph, so it is worth
  // walking from each state a patient could be in when they say it.
  const ENTRY_POINTS = [
    { foodRule: 'after', lead: ['disclose'], from: 'disclose' },
    { foodRule: 'after', lead: ['disclose', 'meal_check'], from: 'meal_check' },
    { foodRule: 'after', lead: ['disclose', 'meal_check', 'dose_check_after'], from: 'dose_check_after' },
    { foodRule: 'before', lead: ['disclose', 'dose_check_before'], from: 'dose_check_before' },
    { foodRule: null, lead: ['disclose', 'dose_check', 'refusal', 'wellbeing'], from: 'wellbeing' },
  ];

  for (const { foodRule, lead, from } of ENTRY_POINTS) {
    test(`reported at "${from}" the call ends in emergency`, async () => {
      const { path, final, ended } = await walk(foodRule, [...lead, 'emergency', 'wellbeing', 'close']);
      assert.strictEqual(final, 'emergency', `a call from ${from} did not end in emergency`);
      assert.ok(ended);
      // The scripted replies keep trying to continue to wellbeing and close.
      // The graph must ignore them: emergency is terminal.
      assert.ok(!path.slice(path.indexOf('emergency') + 1).length, 'the call continued past an emergency');
    });
  }

  test('an opt-out ends the call the same way', async () => {
    const { final, path } = await walk('after', ['disclose', 'opt_out', 'wellbeing', 'close']);
    assert.strictEqual(final, 'opt_out');
    assert.ok(!path.includes('wellbeing'), 'a patient who asked to stop was asked more questions');
  });
});

describe('the router cannot walk a path the graph forbids', () => {
  test('a destination that is not an edge from here is ignored', async () => {
    // The router is a model and models hallucinate. Asking to jump from the
    // greeting straight to close must not work, or every structural guarantee
    // above is decorative.
    const { path } = await walk('after', ['close', 'close', 'close']);
    assert.deepStrictEqual(path, ['greeting'], 'the call jumped an edge that does not exist');
  });
});
