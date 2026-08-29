'use strict';

/**
 * Regression tests for the ElevenLabs-migration prompt/guardrail additions
 * (elevenlabs-migration.md Tasks 1-3), covering both language YAMLs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const { TOOLS } = require('../src/use-cases/medication-adherence/tools');

const LANGS = ['hi', 'en'];

describe('Task 1 — ported guardrails exist in both languages', () => {
  for (const lang of LANGS) {
    const strategy = new MedicationAdherenceStrategy(lang);

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
      const strategy = new MedicationAdherenceStrategy(lang);
      const prompt = strategy.buildSystemPrompt({}, 'outbound');
      // The false-line variant must be what's actually rendered by default,
      // since delivery can never be confirmed live during the call.
      const expectedLine = strategy._resolveAlertDeliveredLine(strategy.getVariables());
      assert.ok(prompt.includes(expectedLine));
      assert.strictEqual(expectedLine, strategy.config.variables.alert_delivered_false_line
        .replace('{caregiver_name}', strategy.config.variables.caregiver_name));
    });

    test(`${lang}: alert_delivered=true renders the "have told" line instead`, () => {
      const strategy = new MedicationAdherenceStrategy(lang);
      const prompt = strategy.buildSystemPrompt({ alert_delivered: true }, 'outbound');
      const expectedLine = strategy.config.variables.alert_delivered_true_line
        .replace('{caregiver_name}', strategy.config.variables.caregiver_name);
      assert.ok(prompt.includes(expectedLine));
    });

    test(`${lang}: no unresolved {alert_delivered_*} placeholders leak into the prompt`, () => {
      const strategy = new MedicationAdherenceStrategy(lang);
      const prompt = strategy.buildSystemPrompt({}, 'outbound');
      assert.ok(!/\{alert_delivered[a-z_]*\}/.test(prompt), `leaked placeholder in: ${prompt}`);
    });
  }
});

describe('Task 2 — outbound "someone else answers" branch exists', () => {
  for (const lang of LANGS) {
    test(`${lang}: outbound system prompt covers a non-patient answering`, () => {
      const strategy = new MedicationAdherenceStrategy(lang);
      const prompt = strategy.buildSystemPrompt({}, 'outbound');
      assert.match(prompt, /IF SOMEONE ELSE ANSWERS/);
    });
  }
});

describe('Task 3 — medical emergency and emotional distress are distinct sequences', () => {
  for (const lang of LANGS) {
    const strategy = new MedicationAdherenceStrategy(lang);

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
      const strategy = new MedicationAdherenceStrategy(lang);
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
