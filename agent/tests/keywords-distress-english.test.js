'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { deriveOutcome } = require('../src/use-cases/medication-adherence/outcomes');
const { DISTRESS_KEYWORDS } = require('../src/use-cases/medication-adherence/keywords');

/**
 * DISTRESS_KEYWORDS was Hindi plus one narrow Hinglish transliteration. It had
 * "marna chahta hoon" but not "marna hai", and no English at all — so
 * "I want to end my life" derived NO_ANSWER, which is the label meaning nobody
 * picked up the phone. A suicidal caller was being recorded as an unanswered
 * call.
 *
 * The asymmetry that governs this list: a false positive costs a caregiver one
 * unnecessary phone call. A false negative costs the thing the product exists
 * to prevent. When in doubt this list errs toward matching.
 *
 * These assertions go through deriveOutcome() rather than the keyword arrays,
 * because the arrays are only half the behaviour — priority ordering against
 * CONFIRMED/DENIED and the negation check both live in outcomes.js, and a
 * keyword that matches but loses the priority race is still a missed emergency.
 */

const label = (utterance) => deriveOutcome({ transcript: `User: ${utterance}`, callId: 'c1' }).label;

describe('distress detection — English', () => {
  const MUST_ESCALATE = [
    'I want to end my life',
    'I want to die',
    'I wanna die',
    'I might kill myself',
    'I want to hurt myself',
    'there is no reason to live',
    "I don't want to live anymore",
    'I feel like giving up on treatment',
    'I am going to stop taking everything',
  ];

  for (const utterance of MUST_ESCALATE) {
    test(`"${utterance}" escalates as distress`, () => {
      assert.strictEqual(
        label(utterance),
        'ESCALATED_DISTRESS',
        'an English self-harm or stop-treatment statement must not fall through to NO_ANSWER'
      );
    });
  }
});

describe('distress detection — Hinglish beyond the original transliterations', () => {
  const MUST_ESCALATE = [
    'mujhe marna hai',
    'main mar jaunga',
    'jeene ka mann nahi hai',
    'zinda nahi rehna chahta',
  ];

  for (const utterance of MUST_ESCALATE) {
    test(`"${utterance}" escalates as distress`, () => {
      assert.strictEqual(label(utterance), 'ESCALATED_DISTRESS');
    });
  }
});

describe('distress detection — Devanagari still works', () => {
  for (const utterance of ['मरना चाहता हूँ', 'जीने का मन नहीं', 'आत्महत्या']) {
    test(`"${utterance}" escalates as distress`, () => {
      assert.strictEqual(label(utterance), 'ESCALATED_DISTRESS');
    });
  }
});

describe('the additions do not swamp ordinary speech', () => {
  // Deliberately excludes "I will stop the treatment" — the tool contract
  // defines ESCALATED_DISTRESS as "emotional distress, a wish to stop
  // treatment, or thoughts of self-harm", so escalating that is correct
  // behaviour, not a false positive.
  const MUST_NOT_ESCALATE = [
    'haan maine dawai le li',
    'I am fine beta, I ate breakfast',
    'I took my tablets after lunch',
    'sab theek hai',
    'the crossword is killing me slowly',
  ];

  for (const utterance of MUST_NOT_ESCALATE) {
    test(`"${utterance}" does not escalate`, () => {
      assert.ok(
        !label(utterance).startsWith('ESCALATED'),
        `ordinary speech escalated: ${label(utterance)}`
      );
    });
  }
});

describe('symptom detection and negation are unaffected', () => {
  test('an English symptom still escalates', () => {
    assert.strictEqual(label('I have chest pain'), 'ESCALATED_SYMPTOM');
  });

  test('a Devanagari symptom still escalates', () => {
    assert.strictEqual(label('सीने में दर्द है'), 'ESCALATED_SYMPTOM');
  });

  test('negated English symptom does not escalate', () => {
    assert.ok(!label('no chest pain today').startsWith('ESCALATED'));
  });

  test('negated Devanagari symptom does not escalate', () => {
    assert.ok(!label('सीने में दर्द नहीं है').startsWith('ESCALATED'));
  });
});

describe('the list itself', () => {
  test('covers English, Hinglish and Devanagari', () => {
    const joined = DISTRESS_KEYWORDS.join('|');
    assert.ok(/end my life/.test(joined), 'no English coverage');
    assert.ok(/marna hai/.test(joined), 'no short-form Hinglish coverage');
    assert.ok(/मरना/.test(joined), 'no Devanagari coverage');
  });
});
