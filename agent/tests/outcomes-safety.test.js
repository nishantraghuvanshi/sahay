'use strict';

/**
 * Safety-loop regression tests for outcome derivation.
 *
 * These cover the three defects identified in PILOT-PLAN.md §1:
 *   D1 — ESCALATED conflated "symptom reported" with "conversation broke down"
 *   D2 — keyword matching was negation-blind and speaker-blind
 *   D3 — DENIED absorbed "unclear_response"
 *
 * Every test here maps to a real failure mode that would reach a caregiver's
 * phone during the pilot, so they are kept separate from the general
 * outcomes.test.js suite.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { deriveOutcome, OUTCOMES } = require('../src/use-cases/medication-adherence/outcomes');

describe('D1 — symptom and conversation-failure are distinct labels', () => {
  test('symptom report yields ESCALATED_SYMPTOM', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED_SYMPTOM', reason: 'fever' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('clarify loop yields INCOMPLETE, not an escalation', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'INCOMPLETE', reason: 'clarify_loop_exceeded' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.INCOMPLETE);
  });

  test('legacy ESCALATED + clarify reason normalises to INCOMPLETE', () => {
    // Older prompt versions (v1) emitted ESCALATED for clarify loops.
    // A v1 assistant still live in Vapi must not page a caregiver.
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED', reason: 'clarify_loop_exceeded' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.INCOMPLETE);
  });

  test('legacy ESCALATED without clarify reason normalises to ESCALATED_SYMPTOM', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED', reason: 'user reported chest pain' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('legacy ESCALATED from Vapi analysis also normalises', () => {
    const result = deriveOutcome({
      analysis: { structuredData: { outcome: 'ESCALATED', reason: 'clarify_loop_exceeded' } },
    });
    assert.strictEqual(result.label, OUTCOMES.INCOMPLETE);
  });
});

describe('D2 — negation must not trigger a symptom escalation', () => {
  test('"कोई दर्द नहीं है" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'नहीं, कोई दर्द नहीं है, मैंने ले ली' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"dard nahi hai" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'dard nahi hai, le liya' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"no pain at all" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'no pain at all, I have taken it' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"बुखार नहीं" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'बुखार नहीं है' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('a genuine symptom still escalates', () => {
    const result = deriveOutcome({ transcript: 'बहुत दर्द हो रहा है' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('negated mention plus a real mention still escalates', () => {
    // "no fever, but a lot of pain" — one negated, one real.
    const result = deriveOutcome({ transcript: 'बुखार नहीं है लेकिन बहुत दर्द है' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('pre-existing behaviour preserved: "nahi liya, dard bahut hai" escalates', () => {
    // Hindi negation is post-positional, so the "nahi" before "dard" belongs
    // to "liya", not to "dard". This must not be read as a negated symptom.
    const result = deriveOutcome({ transcript: 'nahi liya, dard bahut hai' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });
});

describe('D2 — keyword matching is scoped to the caller', () => {
  test('symptom words spoken by the agent do not escalate', () => {
    const transcript = [
      'AI: नमस्ते, क्या आपको कोई दर्द या बुखार है?',
      'User: नहीं, मैंने दवाई ले ली',
    ].join('\n');
    const result = deriveOutcome({ transcript });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('symptom words spoken by the caller do escalate', () => {
    const transcript = [
      'AI: क्या आपने दवाई ले ली?',
      'User: मुझे बहुत दर्द हो रहा है',
    ].join('\n');
    const result = deriveOutcome({ transcript });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('structured user turns are used when provided', () => {
    const result = deriveOutcome({
      userTurns: ['मुझे चक्कर आ रहे हैं'],
      transcript: 'ignored when userTurns is present',
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('messages array with roles is used when provided', () => {
    const result = deriveOutcome({
      messages: [
        { role: 'assistant', content: 'क्या आपको बुखार है?' },
        { role: 'user', content: 'हाँ ले लिया' },
      ],
    });
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('unprefixed transcript is still treated as caller speech', () => {
    // Playground transcripts have no speaker prefixes.
    const result = deriveOutcome({ transcript: 'हाँ ले लिया' });
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });
});

describe('D2 — expanded emergency symptom coverage', () => {
  const emergencies = [
    ['साँस लेने में तकलीफ है', 'breathing'],
    ['सीने में जकड़न है', 'chest'],
    ['मैं गिर गया', 'fall'],
    ['बहुत कमज़ोरी लग रही है', 'weakness'],
    ['saans nahi aa rahi', 'breathing romanized'],
  ];

  for (const [transcript, label] of emergencies) {
    test(`escalates on ${label}`, () => {
      const result = deriveOutcome({ transcript });
      assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM, `failed for: ${transcript}`);
    });
  }
});

describe('D3 — UNCLEAR is distinct from DENIED', () => {
  test('unclear_response yields UNCLEAR, not DENIED', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'UNCLEAR', reason: 'unclear_response' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.UNCLEAR);
  });

  test('legacy DENIED + unclear_response reason normalises to UNCLEAR', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'DENIED', reason: 'unclear_response' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.UNCLEAR);
  });

  test('a real refusal is still DENIED', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'DENIED', reason: 'user said not yet' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.DENIED);
  });
});

describe('OUTCOMES enum shape', () => {
  test('exposes the split labels', () => {
    assert.strictEqual(OUTCOMES.ESCALATED_SYMPTOM, 'ESCALATED_SYMPTOM');
    assert.strictEqual(OUTCOMES.INCOMPLETE, 'INCOMPLETE');
    assert.strictEqual(OUTCOMES.UNCLEAR, 'UNCLEAR');
  });

  test('the ambiguous ESCALATED label is gone', () => {
    assert.strictEqual(OUTCOMES.ESCALATED, undefined);
  });
});
