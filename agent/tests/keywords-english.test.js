'use strict';

/**
 * English symptom-keyword coverage for the fallback keyword matcher.
 *
 * The product supports Hinglish code-switching, but SYMPTOM_KEYWORDS had no
 * English stems at all — a caller saying "chest pain" or "I can't breathe"
 * in English would not match, and the keyword matcher is what runs when the
 * LLM does not call report_outcome. A false negative here is a missed
 * emergency, which is worse than an over-eager false positive, so these
 * cover every emergency category the report_outcome tool enumerates
 * (see tools.js): chest pain, difficulty breathing, severe dizziness,
 * fainting, bleeding, a fall, sudden weakness, slurred speech, severe pain,
 * confusion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { deriveOutcome, OUTCOMES } = require('../src/use-cases/medication-adherence/outcomes');

describe('English symptom keywords escalate', () => {
  const emergencies = [
    ['I have chest pain', 'chest pain'],
    ['I have difficulty breathing', 'difficulty breathing'],
    ['I am having trouble breathing', 'trouble breathing'],
    ["I can't breathe", 'cannot breathe (apostrophe)'],
    ['I cant breathe', 'cannot breathe (no apostrophe)'],
    ['there is shortness of breath', 'shortness of breath'],
    ['I feel very dizzy', 'dizzy'],
    ['I have severe dizziness', 'dizziness'],
    ['I fainted this morning', 'fainted'],
    ['I am bleeding a lot', 'bleeding'],
    ['there is blood on my hand', 'blood'],
    ['I fell down the stairs', 'fell'],
    ['I had a fall', 'fall'],
    ['I feel very weak', 'weak'],
    ['my speech is slurred', 'slurred'],
    ['I am slurring my words', 'slurring'],
    ['I feel confused', 'confused'],
    ['there is a lot of confusion', 'confusion'],
    ['I am in severe pain', 'severe pain'],
    ['I am in a lot of pain', 'a lot of pain'],
  ];

  for (const [transcript, label] of emergencies) {
    test(`escalates on "${label}"`, () => {
      const result = deriveOutcome({ transcript });
      assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM, `failed for: ${transcript}`);
      assert.strictEqual(result.source, 'keyword_match');
    });
  }
});

describe('English negation must still suppress non-emergencies', () => {
  test('"no chest pain" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'no chest pain, I took my medicine' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"not dizzy" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'not dizzy at all, feeling fine' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"no bleeding" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'no bleeding, just a small scratch' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"no difficulty breathing" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'no difficulty breathing, I am okay' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('"never fell" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'never fell, I am steady on my feet' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('a genuine emergency still escalates despite an unrelated negation earlier', () => {
    const result = deriveOutcome({ transcript: 'no fever, but I have chest pain' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });
});

describe('Devanagari negation for the existing Hindi symptom stems (regression)', () => {
  test('"सीने में दर्द नहीं है" does NOT escalate', () => {
    const result = deriveOutcome({ transcript: 'सीने में दर्द नहीं है, मैंने दवाई ले ली' });
    assert.notStrictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });
});
