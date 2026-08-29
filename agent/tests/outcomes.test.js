'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { deriveOutcome, OUTCOMES } = require('../src/use-cases/medication-adherence/outcomes');

describe('deriveOutcome — tool_call source (highest priority)', () => {
  test('returns CONFIRMED from report_outcome tool call', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'CONFIRMED', reason: 'user said yes' } }],
      transcript: 'haan le liya',
    });
    assert.strictEqual(result.label, 'CONFIRMED');
    assert.strictEqual(result.source, 'tool_call');
    assert.strictEqual(result.reason, 'user said yes');
  });

  test('returns DENIED from report_outcome tool call', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'DENIED', reason: 'not taken' } }],
      transcript: 'nahi liya',
    });
    assert.strictEqual(result.label, 'DENIED');
    assert.strictEqual(result.source, 'tool_call');
  });

  test('returns ESCALATED_SYMPTOM from report_outcome tool call', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED_SYMPTOM', reason: 'fever' } }],
      transcript: 'bukhar hai',
    });
    assert.strictEqual(result.label, 'ESCALATED_SYMPTOM');
    assert.strictEqual(result.source, 'tool_call');
  });

  test('handles tool call with function.name format (OpenAI-style)', () => {
    const result = deriveOutcome({
      toolCalls: [{ function: { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED","reason":"ok"}' } }],
    });
    assert.strictEqual(result.label, 'CONFIRMED');
    assert.strictEqual(result.source, 'tool_call');
  });

  test('handles string arguments by parsing JSON', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: '{"outcome":"DENIED","reason":"no"}' }],
    });
    assert.strictEqual(result.label, 'DENIED');
  });

  test('skips non-report_outcome tool calls', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'other_tool', arguments: { foo: 'bar' } }],
      transcript: 'haan le liya',
    });
    // Falls through to keyword match
    assert.strictEqual(result.label, 'CONFIRMED');
    assert.strictEqual(result.source, 'keyword_match');
  });

  test('skips tool call with invalid JSON arguments', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: 'not-json' }],
      transcript: 'haan',
    });
    assert.strictEqual(result.source, 'keyword_match');
  });

  test('skips tool call with missing outcome field', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { reason: 'no outcome field' } }],
      transcript: 'haan',
    });
    assert.strictEqual(result.source, 'keyword_match');
  });

  test('tool_call takes priority over analysis and keywords', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'CONFIRMED' } }],
      analysis: { structuredData: { outcome: 'DENIED' } },
      transcript: 'nahi',
    });
    assert.strictEqual(result.label, 'CONFIRMED');
    assert.strictEqual(result.source, 'tool_call');
  });
});

describe('deriveOutcome — analysis source', () => {
  test('returns outcome from Vapi structured analysis', () => {
    const result = deriveOutcome({
      analysis: { structuredData: { outcome: 'DENIED', reason: 'user said no' } },
    });
    assert.strictEqual(result.label, 'DENIED');
    assert.strictEqual(result.source, 'analysis');
    assert.strictEqual(result.reason, 'user said no');
  });

  test('analysis uses summary as reason if no explicit reason', () => {
    const result = deriveOutcome({
      analysis: { structuredData: { outcome: 'CONFIRMED' }, summary: 'call went well' },
    });
    assert.strictEqual(result.label, 'CONFIRMED');
    assert.strictEqual(result.source, 'analysis');
    assert.strictEqual(result.reason, 'call went well');
  });

  test('analysis takes priority over keywords', () => {
    const result = deriveOutcome({
      analysis: { structuredData: { outcome: 'DENIED' } },
      transcript: 'haan le liya',
    });
    assert.strictEqual(result.label, 'DENIED');
    assert.strictEqual(result.source, 'analysis');
  });

  test('null analysis falls through', () => {
    const result = deriveOutcome({
      analysis: null,
      transcript: 'haan',
    });
    assert.strictEqual(result.source, 'keyword_match');
  });

  test('analysis without structuredData falls through', () => {
    const result = deriveOutcome({
      analysis: { summary: 'some summary' },
      transcript: 'haan',
    });
    assert.strictEqual(result.source, 'keyword_match');
  });
});

describe('deriveOutcome — keyword_match source', () => {
  test('detects Romanized confirmed keywords', () => {
    const result = deriveOutcome({ transcript: 'haan le liya' });
    assert.strictEqual(result.label, 'CONFIRMED');
    assert.strictEqual(result.source, 'keyword_match');
  });

  test('detects Devanagari confirmed keywords', () => {
    const result = deriveOutcome({ transcript: 'हाँ ले लिया' });
    assert.strictEqual(result.label, 'CONFIRMED');
  });

  test('detects Romanized denied keywords', () => {
    const result = deriveOutcome({ transcript: 'nahi abhi nahi liya' });
    assert.strictEqual(result.label, 'DENIED');
  });

  test('detects Devanagari denied keywords', () => {
    const result = deriveOutcome({ transcript: 'नहीं अभी नहीं' });
    assert.strictEqual(result.label, 'DENIED');
  });

  test('symptom keywords take priority over confirmed', () => {
    const result = deriveOutcome({ transcript: 'haan le liya lekin bukhar bhi hai' });
    assert.strictEqual(result.label, 'ESCALATED_SYMPTOM');
    assert.strictEqual(result.source, 'keyword_match');
    assert.strictEqual(result.reason, 'symptom_keyword_detected');
  });

  test('symptom keywords take priority over denied', () => {
    const result = deriveOutcome({ transcript: 'nahi liya, dard bahut hai' });
    assert.strictEqual(result.label, 'ESCALATED_SYMPTOM');
  });

  test('detects Devanagari symptom keywords', () => {
    const result = deriveOutcome({ transcript: 'बुखार है' });
    assert.strictEqual(result.label, 'ESCALATED_SYMPTOM');
  });

  test('case-insensitive matching', () => {
    const result = deriveOutcome({ transcript: 'HAAN LE LIYA' });
    assert.strictEqual(result.label, 'CONFIRMED');
  });

  test('empty transcript falls through to watchdog', () => {
    const result = deriveOutcome({ transcript: '' });
    assert.strictEqual(result.label, 'NO_ANSWER');
    assert.strictEqual(result.source, 'watchdog');
  });

  test('null transcript falls through to watchdog', () => {
    const result = deriveOutcome({ transcript: null });
    assert.strictEqual(result.label, 'NO_ANSWER');
  });

  test('unrecognized transcript falls through to watchdog', () => {
    const result = deriveOutcome({ transcript: 'xyz qwerty random words' });
    assert.strictEqual(result.label, 'NO_ANSWER');
    assert.strictEqual(result.source, 'watchdog');
  });
});

describe('deriveOutcome — watchdog fallback', () => {
  test('returns NO_ANSWER with endedReason', () => {
    const result = deriveOutcome({
      endedReason: 'customer_did_not_answer',
    });
    assert.strictEqual(result.label, 'NO_ANSWER');
    assert.strictEqual(result.source, 'watchdog');
    assert.strictEqual(result.reason, 'customer_did_not_answer');
  });

  test('returns NO_ANSWER with default reason when no endedReason', () => {
    const result = deriveOutcome({});
    assert.strictEqual(result.label, 'NO_ANSWER');
    assert.strictEqual(result.reason, 'no_signal');
  });

  test('returns NO_ANSWER for voicemail', () => {
    const result = deriveOutcome({ endedReason: 'voicemail' });
    assert.strictEqual(result.label, 'NO_ANSWER');
    assert.strictEqual(result.reason, 'voicemail');
  });
});

describe('OUTCOMES constants', () => {
  test('has all expected outcome labels', () => {
    assert.strictEqual(OUTCOMES.CONFIRMED, 'CONFIRMED');
    assert.strictEqual(OUTCOMES.DENIED, 'DENIED');
    assert.strictEqual(OUTCOMES.ESCALATED_SYMPTOM, 'ESCALATED_SYMPTOM');
    assert.strictEqual(OUTCOMES.NO_ANSWER, 'NO_ANSWER');
    assert.strictEqual(OUTCOMES.ERROR, 'ERROR');
  });
});
