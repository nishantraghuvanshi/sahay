'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const { membersFor, normaliseFoodRule, GLOBAL_MEMBERS } = require('../src/use-cases/medication-adherence/squad');

/**
 * The single-prompt design had exactly one virtue worth protecting: guardrails
 * provably applied everywhere, because there was only one prompt. Splitting the
 * call into members trades that for structure, and the trade is only safe if
 * "every member carries the guardrails" is asserted rather than assumed. An
 * audit found the block missing from the one prompt that existed; eleven
 * members is eleven chances to lose it, and a member missing it looks exactly
 * like one that has it.
 *
 * Every structural property here runs against EVERY graph the food rule can
 * select. A property asserted on one variant is a property unasserted on the
 * other two, and the seed data only exercises one of them.
 */

const BASE = { parent_name: 'रोहन', drug_name: 'Crocin', caregiver_name: 'शुभ' };

const VARIANTS = [
  { name: 'after food', foodRule: 'after' },
  { name: 'before food', foodRule: 'before' },
  { name: 'no food rule', foodRule: null },
];

const membersOf = (foodRule) =>
  new MedicationAdherenceStrategy().buildSquadMembers({ ...BASE, food_rule: foodRule });

for (const variant of VARIANTS) {
  describe(`the "${variant.name}" graph`, () => {
    const members = () => membersOf(variant.foodRule);

    test('every member carries the full guardrail block', () => {
      const REQUIRED = ['GUARDRAILS', 'MEDICAL EMERGENCY', 'EMOTIONAL DISTRESS', 'ambulance', 'diagnose'];
      for (const m of members()) {
        for (const clause of REQUIRED) {
          assert.ok(
            m.systemPrompt.toLowerCase().includes(clause.toLowerCase()),
            `member "${m.key}" is missing "${clause}" — it would answer an emergency unguarded`
          );
        }
      }
    });

    test('no member is meaningfully shorter than its siblings', () => {
      // A member whose prompt is a fraction of the others' has almost certainly
      // lost the shared tail, whatever the clause checks say. Two independent
      // detectors, because this is the property that matters most.
      const lengths = members().map((m) => m.systemPrompt.length);
      assert.ok(
        Math.max(...lengths) - Math.min(...lengths) < 1500,
        `prompt lengths vary too widely (${Math.min(...lengths)}..${Math.max(...lengths)})`
      );
    });

    test('exactly one member speaks first, and it is the greeting', () => {
      const firsts = members().filter((m) => m.first);
      assert.strictEqual(firsts.length, 1, 'a squad needs exactly one entry point');
      assert.strictEqual(firsts[0].key, 'greeting');
    });

    test('every member is reachable from the entry point', () => {
      const built = members();
      const byKey = new Map(built.map((m) => [m.key, m]));
      const seen = new Set(['greeting']);
      const queue = ['greeting'];
      while (queue.length) {
        for (const d of byKey.get(queue.pop()).destinations) {
          if (!seen.has(d.to)) {
            seen.add(d.to);
            queue.push(d.to);
          }
        }
      }
      assert.deepStrictEqual(
        built.map((m) => m.key).filter((k) => !seen.has(k)),
        [],
        'a member nothing can reach is dead prompt text'
      );
    });

    test('every member can reach a terminal state', () => {
      // The inverse of reachability, and the one that matters to a caller: a
      // member with no path to `close` is a call that cannot end normally.
      const built = members();
      const byKey = new Map(built.map((m) => [m.key, m]));
      for (const start of built) {
        const seen = new Set([start.key]);
        const queue = [start.key];
        let terminal = false;
        while (queue.length && !terminal) {
          const here = byKey.get(queue.pop());
          if (here.terminal) { terminal = true; break; }
          for (const d of here.destinations) {
            if (!seen.has(d.to)) { seen.add(d.to); queue.push(d.to); }
          }
        }
        assert.ok(terminal, `"${start.key}" has no path to a terminal member — the call cannot end from there`);
      }
    });

    test('no destination points at a member that does not exist', () => {
      const keys = new Set(members().map((m) => m.key));
      for (const m of members()) {
        for (const d of m.destinations) {
          assert.ok(keys.has(d.to), `${m.key} -> ${d.to} is a dead end mid-call`);
        }
      }
    });

    test('every destination carries a condition Vapi can match on', () => {
      for (const m of members()) {
        for (const d of m.destinations) {
          assert.ok(
            d.description && d.description.length > 20,
            `${m.key} -> ${d.to} has no usable semantic condition`
          );
        }
      }
    });

    for (const key of GLOBAL_MEMBERS) {
      test(`every non-terminal member can reach "${key}"`, () => {
        for (const m of members()) {
          if (m.terminal || m.key === key) continue;
          assert.ok(
            m.destinations.map((d) => d.to).includes(key),
            `"${m.key}" cannot reach "${key}" — a patient who says it at that moment is stuck. ` +
              'The reference design reached emergency from two nodes only; this is the bug that fixes.'
          );
        }
      });
    }

    test('a terminal member cannot transition away', () => {
      // Once the emergency sequence has run there is no path back to the
      // medication reminder. In the single-prompt design that was a sentence
      // the model chose to obey; here it is not expressible.
      for (const m of members()) {
        if (!m.terminal) continue;
        assert.deepStrictEqual(m.destinations, [], `terminal member "${m.key}" can leave`);
      }
    });

    test('the greeting never names the medicine', () => {
      // Naming a drug before confirming who is holding the phone discloses a
      // diagnosis to whoever picked up. That is why greeting is its own state.
      const greeting = members().find((m) => m.key === 'greeting');
      const definition = membersFor(variant.foodRule).find((m) => m.key === 'greeting');
      assert.ok(!definition.goal.includes('{{drug_name}}'), 'the greeting goal interpolates the drug name');
      assert.ok(
        /do not say the medicine name/i.test(greeting.systemPrompt),
        'the greeting no longer forbids naming the medicine'
      );
    });
  });
}

describe('the food rule selects the graph rather than branching inside it', () => {
  test('an after-food regimen gates the dose on the meal', () => {
    const keys = membersOf('after').map((m) => m.key);
    assert.ok(keys.includes('meal_check'), 'after-food should ask about the meal first');
    assert.ok(keys.includes('callback_meal'), 'after-food needs the not-yet-eaten path');
    assert.ok(!keys.includes('timing_mismatch'), 'before-food states must not be built for an after-food regimen');
  });

  test('a before-food regimen handles the missed window', () => {
    const keys = membersOf('before').map((m) => m.key);
    assert.ok(keys.includes('timing_mismatch'), 'before-food needs the already-eaten path');
    assert.ok(!keys.includes('meal_check'), 'after-food states must not be built for a before-food regimen');
  });

  test('an unknown food rule falls back to the generic spine, not a guess', () => {
    // Asking about a meal the prescription never mentioned is worse than not
    // asking, so anything unrecognised gets the neutral path.
    for (const raw of [null, undefined, '', 'as directed', 'twice daily']) {
      const keys = membersOf(raw).map((m) => m.key);
      assert.ok(keys.includes('dose_check'), `"${raw}" should yield the generic dose check`);
      assert.ok(!keys.includes('meal_check'), `"${raw}" must not invent a meal gate`);
    }
  });

  test('normaliseFoodRule reads the forms a prescription actually uses', () => {
    for (const raw of ['after', 'After Food', 'take after meals', 'pc', 'post-meal']) {
      assert.strictEqual(normaliseFoodRule(raw), 'after', `"${raw}"`);
    }
    for (const raw of ['before', 'Before Food', 'ac', 'on empty stomach']) {
      assert.strictEqual(normaliseFoodRule(raw), 'before', `"${raw}"`);
    }
    for (const raw of [null, '', 'as directed']) {
      assert.strictEqual(normaliseFoodRule(raw), 'none', `"${raw}"`);
    }
  });
});

describe('dosing decisions stay out of the agent', () => {
  // Prompts are hand-wrapped, so a phrase can straddle a newline. Match against
  // whitespace-collapsed text or the assertion tests the line breaks.
  const flat = (m) => m.systemPrompt.replace(/\s+/g, ' ');

  test('the missed-window state never tells the patient what to do', () => {
    const m = membersOf('before').find((x) => x.key === 'timing_mismatch');
    assert.ok(/not yours to make/i.test(flat(m)), 'timing mismatch must refuse the dosing decision');
    assert.ok(/do not tell them to take it/i.test(flat(m)));
    assert.ok(/do not tell them to skip it/i.test(flat(m)));
  });

  test('the not-yet-eaten state never instructs a dose or a meal', () => {
    const m = membersOf('after').find((x) => x.key === 'callback_meal');
    assert.ok(/do not tell them to take it anyway/i.test(flat(m)));
    assert.ok(/that is prescribing/i.test(flat(m)));
  });
});

describe('the debug flag behaves the same way it does for single prompts', () => {
  test('DISABLE_GUARDRAILS strips the block from every member, not some', () => {
    const previous = process.env.DISABLE_GUARDRAILS;
    process.env.DISABLE_GUARDRAILS = 'true';
    try {
      for (const m of membersOf('after')) {
        assert.ok(
          !m.systemPrompt.includes('GUARDRAILS'),
          `member "${m.key}" kept its guardrails while others lost theirs — ` +
            'partial stripping is worse than none, because the suite would look healthy'
        );
      }
    } finally {
      if (previous === undefined) delete process.env.DISABLE_GUARDRAILS;
      else process.env.DISABLE_GUARDRAILS = previous;
    }
  });
});
