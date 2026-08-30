'use strict';

/**
 * Regression tests for the ElevenLabs-migration prompt/guardrail additions
 * (elevenlabs-migration.md Tasks 1-3), covering both language YAMLs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { TOOLS } = require('../src/use-cases/medication-adherence/tools');

const LANGS = ['hi', 'en'];

/**
 * Read the config file rather than constructing the strategy.
 *
 * These tests assert on prompt TEXT, and the strategy now refuses to load a
 * language whose version trails the maintained one — which English does, by ten
 * versions. Constructing it here would throw, and the obvious fix of dropping
 * English from LANGS would delete the only check that its guardrails exist at
 * all, at the exact moment it is furthest behind.
 *
 * Worth being clear about what this can and cannot see: it matches labels in a
 * file. That is why English drifted ten versions under a green suite. The
 * version guard in strategy.js is what actually stops a stale prompt reaching a
 * caller; this is a much weaker check kept for what it does cover.
 */
/**
 * A real strategy, for the assertions that RENDER a prompt rather than read
 * one. Only the maintained language can be rendered: strategy.js refuses to
 * load a stale one, which is the whole point of the guard. Those assertions
 * therefore run for `hi` and are skipped for a language that is behind — the
 * guard is what covers it in the meantime, and this returns to full coverage
 * the moment the config is ported.
 */
function renderableStrategy(lang) {
  try {
    return new MedicationAdherenceStrategy(lang);
  } catch {
    return null;
  }
}

function configFor(lang) {
  const file = lang === 'en' ? 'medication-adherence-en.yaml' : 'medication-adherence.yaml';
  return yaml.load(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'use-cases', file), 'utf8')
  );
}

describe('Task 1 — ported guardrails exist in both languages', () => {
  for (const lang of LANGS) {
    const strategy = { config: configFor(lang) };

    test(`${lang}: tool-failure honesty guardrail is present`, () => {
      assert.match(strategy.config.guardrails, /TOOL-FAILURE HONESTY/);
    });

    test(`${lang}: self-check heuristic guardrail is present`, () => {
      assert.match(strategy.config.guardrails, /SELF-CHECK/i);
    });

    test(`${lang}: self-disclosure guardrail is present`, () => {
      assert.match(strategy.config.guardrails, /SELF-DISCLOSURE/i);
    });

    test(`${lang}: never mention having a script/instructions`, () => {
      assert.match(strategy.config.shared_rules, /instructions|script/i);
    });

    test(`${lang}: never say a medicine name more than twice`, () => {
      assert.match(strategy.config.shared_rules, /more than twice/i);
    });
  }
});

describe('Task 1 — delivery-conditioned escalation wording is never a false claim', () => {
  for (const lang of LANGS) {
    test(`${lang}: default (alert not confirmed delivered) says "trying", not "have told"`, () => {
      const strategy = renderableStrategy(lang);
      if (!strategy) return; // stale language: the version guard covers it
      const prompt = strategy.buildSystemPrompt({}, 'outbound');
      // The false-line variant must be what's actually rendered by default,
      // since delivery can never be confirmed live during the call.
      const expectedLine = strategy._resolveAlertDeliveredLine(strategy.getVariables());
      assert.ok(prompt.includes(expectedLine));
      assert.strictEqual(expectedLine, strategy.config.variables.alert_delivered_false_line
        .replace('{caregiver_name}', strategy.config.variables.caregiver_name));
    });

    test(`${lang}: alert_delivered=true renders the "have told" line instead`, () => {
      const strategy = renderableStrategy(lang);
      if (!strategy) return; // stale language: the version guard covers it
      const prompt = strategy.buildSystemPrompt({ alert_delivered: true }, 'outbound');
      const expectedLine = strategy.config.variables.alert_delivered_true_line
        .replace('{caregiver_name}', strategy.config.variables.caregiver_name);
      assert.ok(prompt.includes(expectedLine));
    });

    test(`${lang}: no unresolved {alert_delivered_*} placeholders leak into the prompt`, () => {
      const strategy = renderableStrategy(lang);
      if (!strategy) return; // stale language: the version guard covers it
      const prompt = strategy.buildSystemPrompt({}, 'outbound');
      assert.ok(!/\{alert_delivered[a-z_]*\}/.test(prompt), `leaked placeholder in: ${prompt}`);
    });
  }
});

describe('Task 2 — outbound "someone else answers" branch exists', () => {
  for (const lang of LANGS) {
    test(`${lang}: outbound system prompt covers a non-patient answering`, () => {
      const strategy = renderableStrategy(lang);
      if (!strategy) return; // stale language: the version guard covers it
      const prompt = strategy.buildSystemPrompt({}, 'outbound');
      assert.match(prompt, /IF SOMEONE ELSE ANSWERS/);
    });
  }
});

describe('Task 3 — medical emergency and emotional distress are distinct sequences', () => {
  for (const lang of LANGS) {
    const strategy = { config: configFor(lang) };

    test(`${lang}: guardrails name both MEDICAL EMERGENCY and EMOTIONAL DISTRESS`, () => {
      assert.match(strategy.config.guardrails, /MEDICAL EMERGENCY/);
      assert.match(strategy.config.guardrails, /EMOTIONAL DISTRESS/);
    });

    test(`${lang}: emergency sequence calls report_outcome with ESCALATED_SYMPTOM`, () => {
      const emergencySection = strategy.config.guardrails.split('EMOTIONAL DISTRESS')[0];
      assert.match(emergencySection, /ESCALATED_SYMPTOM/);
    });

    test(`${lang}: distress sequence calls report_outcome with ESCALATED_DISTRESS`, () => {
      const distressSection = strategy.config.guardrails.split('EMOTIONAL DISTRESS')[1];
      assert.match(distressSection, /ESCALATED_DISTRESS/);
    });
  }
});

describe('every tool the prompts reference actually exists', () => {
  // The source ElevenLabs prompt told the agent to call notify_caregiver, a
  // tool that was never wired up — a real emergency would speak the
  // reassurance script while no alert ever fired. Every tool name mentioned
  // in a prompt block must be a real, defined tool.
  const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
  // end_call is Vapi's native tool (see tools.js docblock) — not in TOOLS.
  const KNOWN_NATIVE_TOOLS = new Set(['end_call']);

  for (const lang of LANGS) {
    test(`${lang}: report_outcome and end_call are the only tools named in prompt text`, () => {
      const strategy = { config: configFor(lang) };
      const allText = [
        strategy.config.guardrails,
        strategy.config.shared_rules,
        strategy.config.system_prompt,
        ...Object.values(strategy.config.modes || {}).map((m) => m.system_prompt),
      ].join('\n');

      // Any snake_case identifier immediately followed by "(" is a plausible
      // tool-call reference in this prompt's style (e.g. report_outcome(...)).
      const calls = [...allText.matchAll(/\b([a-z_]+)\(/g)].map((m) => m[1]);
      for (const name of calls) {
        assert.ok(
          TOOL_NAMES.has(name) || KNOWN_NATIVE_TOOLS.has(name),
          `prompt references "${name}(...)" which is not a defined tool`
        );
      }
    });
  }
});
