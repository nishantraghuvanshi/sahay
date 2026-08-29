'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * One agent, three entry modes.
 *
 *   outbound — scheduled dose call
 *   inbound  — the parent rings in; the agent already holds their record
 *   resume   — a dropped call is picked up without re-asking anything
 *
 * Guardrails are stored once and composed into every mode. Three modes each
 * carrying their own copy is three copies that drift, and the one that drifts
 * is the one that gives medical advice at 3am.
 */

const MODES = ['outbound', 'inbound', 'resume'];

describe('mode surface', () => {
  const strategy = new MedicationAdherenceStrategy();

  test('getModes lists all three', () => {
    assert.deepStrictEqual(strategy.getModes().sort(), [...MODES].sort());
  });

  test('buildSystemPrompt defaults to outbound', () => {
    assert.strictEqual(
      strategy.buildSystemPrompt({}),
      strategy.buildSystemPrompt({}, 'outbound')
    );
  });

  test('buildFirstMessage defaults to outbound', () => {
    assert.strictEqual(
      strategy.buildFirstMessage({}),
      strategy.buildFirstMessage({}, 'outbound')
    );
  });

  for (const mode of MODES) {
    test(`${mode} has a non-empty system prompt`, () => {
      const prompt = strategy.buildSystemPrompt({}, mode);
      assert.ok(prompt && prompt.trim().length > 0);
    });

    test(`${mode} has a non-empty first message`, () => {
      const msg = strategy.buildFirstMessage({}, mode);
      assert.ok(msg && msg.trim().length > 0);
    });
  }

  test('an unknown mode throws and lists what exists', () => {
    assert.throws(
      () => strategy.buildSystemPrompt({}, 'sideways'),
      /Unknown mode: "sideways".*outbound/s
    );
  });

  test('the three modes are actually different prompts', () => {
    const prompts = MODES.map((m) => strategy.buildSystemPrompt({}, m));
    assert.strictEqual(new Set(prompts).size, MODES.length, 'modes must not be copies');
  });
});

describe('guardrails are shared, not duplicated', () => {
  const strategy = new MedicationAdherenceStrategy();

  test('the config stores guardrails exactly once', () => {
    assert.ok(strategy.config.guardrails, 'config should have a guardrails block');
  });

  for (const mode of MODES) {
    test(`${mode} composes the shared guardrails`, () => {
      const prompt = strategy.buildSystemPrompt({}, mode);
      const guardrails = strategy.config.guardrails.trim();
      // Compare on a distinctive line rather than the whole block, so
      // variable substitution inside guardrails does not break the check.
      const marker = guardrails.split('\n').find((l) => l.trim().length > 20).trim();
      assert.ok(prompt.includes(marker), `${mode} is missing the shared guardrails`);
    });
  }

  test('no mode block redefines guardrails inline', () => {
    // If a mode prompt contains its own copy, the shared block is no longer
    // the single source of truth.
    for (const mode of MODES) {
      const raw = strategy.getModeBlock(mode).system_prompt;
      assert.ok(
        !/NEVER diagnose/i.test(raw),
        `${mode} carries an inline guardrail — it belongs in config.guardrails`
      );
    }
  });
});

describe('variable substitution works in every mode', () => {
  const strategy = new MedicationAdherenceStrategy();

  test('inbound first message substitutes the parent name', () => {
    const msg = strategy.buildFirstMessage({ parent_name: 'Sunita' }, 'inbound');
    assert.ok(msg.includes('Sunita'));
  });

  test('resume first message substitutes what is already known', () => {
    const msg = strategy.buildFirstMessage(
      { parent_name: 'Sunita', fields_summary: 'seene mein dard' },
      'resume'
    );
    assert.ok(msg.includes('Sunita'));
    assert.ok(msg.includes('seene mein dard'), 'resume must state what it already has');
  });

  test('unsubstituted placeholders do not survive into a first message', () => {
    const msg = strategy.buildFirstMessage(
      { parent_name: 'Sunita', drug_name: 'Crocin', fields_summary: 'x', missing_field: 'y' },
      'resume'
    );
    assert.ok(!/\{[a-z_]+\}/.test(msg), `placeholder left unreplaced in: ${msg}`);
  });
});

describe('prompt version tracks prompt changes', () => {
  test('version is at least 3 after the mode split', () => {
    const strategy = new MedicationAdherenceStrategy();
    assert.ok(
      strategy.getPromptVersion() >= 3,
      'splitting one prompt into three modes is a prompt change'
    );
  });
});
