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

describe('D4 — an escalation is never masked by an earlier benign report', () => {
  // Found by running the ElevenLabs scenario battery. The agent is instructed
  // to call report_outcome "EXACTLY ONCE per call", and it does not: in the
  // chest-pain scenario it reported CONFIRMED, then ESCALATED_SYMPTOM once the
  // patient mentioned chest heaviness, then ESCALATED_DISTRESS.
  //
  // checkToolCalls returned on the FIRST report_outcome, so the persisted
  // outcome was CONFIRMED and no family alert would ever have fired — for a
  // patient reporting chest pain and fear. The transport made it visible, but
  // the defect is in shared derivation code and applies to Vapi too.
  //
  // First-wins is kept for every other case, deliberately: it is the existing
  // behaviour and the agent's first call is normally its considered answer.
  // Only an escalation overrides, because only an escalation has a cost when
  // it is missed.
  const call = (outcome, reason) => ({
    name: 'report_outcome',
    arguments: { outcome, reason },
  });

  test('a later ESCALATED_SYMPTOM overrides an earlier CONFIRMED', () => {
    const result = deriveOutcome({
      toolCalls: [call('CONFIRMED', 'user confirmed'), call('ESCALATED_SYMPTOM', 'chest pain')],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
    assert.strictEqual(result.reason, 'chest pain');
  });

  test('a later ESCALATED_DISTRESS overrides an earlier CONFIRMED', () => {
    const result = deriveOutcome({
      toolCalls: [call('CONFIRMED', 'user confirmed'), call('ESCALATED_DISTRESS', 'wants to stop')],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_DISTRESS);
  });

  test('the real three-call sequence from the battery escalates', () => {
    const result = deriveOutcome({
      toolCalls: [
        call('CONFIRMED', 'user confirmed taking medicine'),
        call('ESCALATED_SYMPTOM', 'user reported chest pain and fear'),
        call('ESCALATED_DISTRESS', 'user expressed fear/distress'),
      ],
    });
    // The medical emergency outranks the distress that followed it.
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('ESCALATED_SYMPTOM outranks ESCALATED_DISTRESS regardless of order', () => {
    const result = deriveOutcome({
      toolCalls: [call('ESCALATED_DISTRESS', 'low mood'), call('ESCALATED_SYMPTOM', 'fainted')],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('a clarify-loop INCOMPLETE does NOT get promoted into an escalation', () => {
    // normaliseLabel turns legacy ESCALATED + clarify reason into INCOMPLETE.
    // The override must run on the NORMALISED label, or a broken conversation
    // would page a caregiver — which is exactly defect D1.
    const result = deriveOutcome({
      toolCalls: [
        call('CONFIRMED', 'user confirmed'),
        call('ESCALATED', 'clarify_loop_exceeded'),
      ],
    });
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('with no escalation present, the first report still wins', () => {
    const result = deriveOutcome({
      toolCalls: [call('DENIED', 'not yet'), call('CONFIRMED', 'took it after all')],
    });
    assert.strictEqual(result.label, OUTCOMES.DENIED);
    assert.strictEqual(result.source, 'tool_call');
  });

  test('a single report is unaffected', () => {
    const result = deriveOutcome({ toolCalls: [call('CONFIRMED', 'user confirmed')] });
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('malformed entries between reports are skipped, not fatal', () => {
    const result = deriveOutcome({
      toolCalls: [
        call('CONFIRMED', 'user confirmed'),
        { name: 'report_outcome', arguments: 'not json at all' },
        { name: 'capture_field', arguments: { field: 'x', value: 'y' } },
        call('ESCALATED_SYMPTOM', 'breathlessness'),
      ],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });
});

describe('D5 — "ate" must not be read as "took the medicine"', () => {
  // A real call, v15. The agent asked "क्या आपने खाना खा लिया है?" — the food
  // question added for food-dependent doses — the caller answered about FOOD,
  // report_outcome never fired because they hung up, and tier-3 keyword
  // matching read "खा लिया" as a dose confirmation. The call was persisted
  // CONFIRMED / confirmed_keyword_detected for a dose that was never taken.
  //
  // "खा लिया" / "kha liya" mean "ate". They only ever meant "took the tablet"
  // by accident of context, and the food question removed that accident. A
  // false CONFIRMED writes "dose taken" into a caregiver's record, which is
  // the single worst thing this system can get wrong quietly.
  test('answering the food question does not confirm the dose', () => {
    const result = deriveOutcome({
      transcript: 'agent: क्या आपने खाना खा लिया है?\nuser: हाँ, खाना खा लिया है।',
    });
    assert.notStrictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('the romanized form is equally not a confirmation', () => {
    // The agent's question has to be in the transcript, because it is the
    // question that makes the answer ambiguous. A transcript holding only the
    // caller's "haan" and no question is indistinguishable from a plain dose
    // confirmation, and is treated as one.
    const result = deriveOutcome({
      transcript: 'agent: khana kha liya hai?\nuser: haan khana kha liya hai',
    });
    assert.notStrictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('a bare yes still confirms on a call that never mentioned food', () => {
    // The narrowing must not cost the commonest real confirmation there is.
    const result = deriveOutcome({
      transcript: 'agent: क्या आपने ले लिया है?\nuser: हाँ',
    });
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });

  test('a real dose confirmation still confirms', () => {
    // NB "दवाई ले ली है" matches nothing today — "ले ली" is absent from the
    // keyword list while "ले लिया" is there. A pre-existing gap, and the safe
    // direction to be wrong in: a missed confirmation falls through to
    // NO_ANSWER rather than inventing adherence.
    for (const said of ['हाँ, ले लिया', 'haan le liya', 'हो गया']) {
      const result = deriveOutcome({ transcript: `user: ${said}` });
      assert.strictEqual(result.label, OUTCOMES.CONFIRMED, said);
    }
  });

  test('a tool call still wins over any keyword reading', () => {
    // Tier 1 beats tier 3: an explicit report_outcome is unaffected by this.
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'CONFIRMED', reason: 'said so' } }],
      transcript: 'user: खाना खा लिया है',
    });
    assert.strictEqual(result.label, OUTCOMES.CONFIRMED);
  });
});
