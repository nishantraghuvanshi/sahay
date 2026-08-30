'use strict';

/**
 * The /webhook endpoint has no signature verification (unauthenticated),
 * so any reachable caller can post a report_outcome tool-call payload with
 * an arbitrary `outcome` value. deriveOutcome() never throws on malformed
 * input, but before this fix it would happily stringify a junk object
 * (e.g. `{a: {b: 1}}`) into the label "[OBJECT OBJECT]" and persist that to
 * calls.outcome_label, which then renders straight to a caregiver.
 *
 * Fix: normaliseLabel's output is validated against the known OUTCOMES enum;
 * anything outside it falls back to UNCLEAR — the "we do not know" outcome —
 * never to NO_ANSWER. UNCLEAR and NO_ANSWER are not interchangeable: UNCLEAR
 * means "we don't know what happened", NO_ANSWER means "the patient was not
 * reached", and conflating them (i.e. treating an unrecognised label as a
 * missed call) would be a false clinical claim.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { deriveOutcome, OUTCOMES } = require('../src/use-cases/medication-adherence/outcomes');

function toolCallOutcome(outcome, reason) {
  return { toolCalls: [{ name: 'report_outcome', arguments: { outcome, reason } }] };
}

describe('deriveOutcome — junk outcome values never persist a stringified object', () => {
  test('a nested object outcome falls back to UNCLEAR, not "[object Object]"', () => {
    const result = deriveOutcome(toolCallOutcome({ a: { b: 1 } }, 'whatever'));
    assert.strictEqual(result.label, OUTCOMES.UNCLEAR);
    assert.notStrictEqual(result.label, '[OBJECT OBJECT]');
  });

  test('the fallback is UNCLEAR, never NO_ANSWER — unknown is not a synonym for missed', () => {
    const result = deriveOutcome(toolCallOutcome({ a: { b: 1 } }, 'whatever'));
    assert.notStrictEqual(result.label, OUTCOMES.NO_ANSWER);
  });

  test('an array outcome falls back to UNCLEAR', () => {
    const result = deriveOutcome(toolCallOutcome([1, 2, 3], 'whatever'));
    assert.strictEqual(result.label, OUTCOMES.UNCLEAR);
  });

  test('a random unrecognised string outcome falls back to UNCLEAR', () => {
    const result = deriveOutcome(toolCallOutcome('TOTALLY_MADE_UP', 'whatever'));
    assert.strictEqual(result.label, OUTCOMES.UNCLEAR);
  });

  test('the same junk-object case reached via Vapi analysis also falls back to UNCLEAR', () => {
    const result = deriveOutcome({
      analysis: { structuredData: { outcome: { a: { b: 1 } }, reason: 'whatever' } },
    });
    assert.strictEqual(result.label, OUTCOMES.UNCLEAR);
  });

  test('a genuinely valid outcome is unaffected by the new validation', () => {
    const result = deriveOutcome(toolCallOutcome('CONFIRMED', 'user said yes'));
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('source and reason are still reported for a junk outcome', () => {
    const result = deriveOutcome(toolCallOutcome({ a: 1 }, 'weird_reason'));
    assert.strictEqual(result.source, 'tool_call');
    assert.strictEqual(result.reason, 'weird_reason');
  });
});
