'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const { MEMBERS, GLOBAL_MEMBERS } = require('../src/use-cases/medication-adherence/squad');

/**
 * The single-prompt design had exactly one virtue worth protecting: guardrails
 * provably applied everywhere, because there was only one prompt. Splitting the
 * call into members trades that for structure, and the trade is only safe if
 * "every member carries the guardrails" is asserted rather than assumed.
 *
 * An audit found the guardrail block missing from the one prompt that existed.
 * With seven members there are seven chances to lose it, and a member missing
 * it looks exactly like one that has it.
 */

const VARS = { parent_name: 'रोहन', drug_name: 'Crocin', caregiver_name: 'शुभ' };
const members = () => new MedicationAdherenceStrategy().buildSquadMembers(VARS);

describe('every member carries the safety guardrails', () => {
  // The clauses that change what the agent may say to someone in trouble.
  const REQUIRED = ['GUARDRAILS', 'MEDICAL EMERGENCY', 'EMOTIONAL DISTRESS', 'ambulance', 'diagnose'];

  for (const member of MEMBERS) {
    test(`"${member.key}" has the full guardrail block`, () => {
      const built = members().find((m) => m.key === member.key);
      assert.ok(built, `member ${member.key} was not built`);
      for (const clause of REQUIRED) {
        assert.ok(
          built.systemPrompt.toLowerCase().includes(clause.toLowerCase()),
          `member "${member.key}" is missing "${clause}" — it would answer an emergency unguarded`
        );
      }
    });
  }

  test('no member is meaningfully shorter than the others', () => {
    // A member whose prompt is a fraction of its siblings' has almost certainly
    // lost the shared tail, whatever the clause checks say.
    const lengths = members().map((m) => m.systemPrompt.length);
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);
    assert.ok(max - min < 1500, `member prompt lengths vary too widely (${min}..${max})`);
  });
});

describe('the graph is navigable', () => {
  test('exactly one member speaks first', () => {
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
    const unreachable = built.map((m) => m.key).filter((k) => !seen.has(k));
    assert.deepStrictEqual(unreachable, [], 'a member nothing can reach is dead prompt text');
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
});

describe('emergency and opt-out are reachable from anywhere', () => {
  for (const key of GLOBAL_MEMBERS) {
    test(`every non-terminal member can reach "${key}"`, () => {
      for (const m of members()) {
        if (m.terminal || m.key === key) continue;
        const targets = m.destinations.map((d) => d.to);
        assert.ok(
          targets.includes(key),
          `"${m.key}" cannot reach "${key}" — a patient who says it at that moment is stuck. ` +
            'The reference design reached emergency from two nodes only; this is the bug that fixes.'
        );
      }
    });
  }

  test('a terminal member cannot transition away', () => {
    // Notably: once the emergency sequence has run, there is no path back to
    // the medication reminder. In the single-prompt design that was a sentence
    // the model chose to obey; here it is simply not expressible.
    for (const m of members()) {
      if (!m.terminal) continue;
      assert.deepStrictEqual(
        m.destinations,
        [],
        `terminal member "${m.key}" can leave — an emergency must not return to the reminder`
      );
    }
  });
});

describe('member goals stay single-purpose', () => {
  test('the greeting never names the medicine', () => {
    // Naming a drug before confirming who is holding the phone discloses a
    // diagnosis to whoever picked up. This is the reason greeting is its own
    // state rather than the first paragraph of one long prompt.
    const greeting = members().find((m) => m.key === 'greeting');
    const goal = MEMBERS.find((m) => m.key === 'greeting').goal;
    assert.ok(!goal.includes('{{drug_name}}'), 'the greeting goal interpolates the drug name');
    assert.ok(
      /do not say the medicine name/i.test(greeting.systemPrompt),
      'the greeting no longer forbids naming the medicine'
    );
  });
});

describe('the debug flag behaves the same way it does for single prompts', () => {
  test('DISABLE_GUARDRAILS strips the block from every member, not some', () => {
    const previous = process.env.DISABLE_GUARDRAILS;
    process.env.DISABLE_GUARDRAILS = 'true';
    try {
      const stripped = new MedicationAdherenceStrategy().buildSquadMembers(VARS);
      for (const m of stripped) {
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
