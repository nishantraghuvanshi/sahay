'use strict';

/**
 * ESCALATED_DISTRESS regression tests.
 *
 * Split out of ESCALATED_SYMPTOM (elevenlabs-migration.md Task 3): a medical
 * emergency and emotional distress get different, differently-urgent
 * responses, so conflating them either rushes a distressed person through a
 * "contact your doctor now" script or under-reacts to a real emergency.
 *
 * A stale prompt still emitting the legacy `ESCALATED` label must normalise
 * to the SAFER of the two outcomes (ESCALATED_SYMPTOM, which always
 * escalates to both operator and caregiver), never to ESCALATED_DISTRESS —
 * see outcomes-safety.test.js for that guarantee, kept unchanged here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { deriveOutcome, OUTCOMES } = require('../src/use-cases/medication-adherence/outcomes');
const EscalationAlertPlugin = require('../src/use-cases/medication-adherence/plugins/escalation-alert');

describe('deriveOutcome — ESCALATED_DISTRESS', () => {
  test('tool_call reports ESCALATED_DISTRESS directly', () => {
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED_DISTRESS', reason: 'wants to stop treatment' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_DISTRESS);
    assert.strictEqual(result.source, 'tool_call');
  });

  test('Romanized distress keyword escalates to ESCALATED_DISTRESS', () => {
    const result = deriveOutcome({ transcript: 'dawai band karna chahta hoon' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_DISTRESS);
    assert.strictEqual(result.source, 'keyword_match');
  });

  test('Devanagari distress keyword escalates to ESCALATED_DISTRESS', () => {
    const result = deriveOutcome({ transcript: 'मैं जीना नहीं चाहता' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_DISTRESS);
  });

  test('a genuine physical symptom still wins over a distress mention', () => {
    // Symptom keywords are checked first — an emergency must never be
    // demoted to the lower-key distress path.
    const result = deriveOutcome({ transcript: 'बहुत दर्द है और मरना चाहता हूँ' });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });

  test('legacy ESCALATED label never normalises to ESCALATED_DISTRESS', () => {
    // The safer of the two outcomes (ESCALATED_SYMPTOM pages operator AND
    // caregiver unconditionally) is what silence must default to.
    const result = deriveOutcome({
      toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED', reason: 'wants to stop treatment' } }],
    });
    assert.strictEqual(result.label, OUTCOMES.ESCALATED_SYMPTOM);
  });
});

describe('OUTCOMES enum includes the distress label', () => {
  test('ESCALATED_DISTRESS is exposed', () => {
    assert.strictEqual(OUTCOMES.ESCALATED_DISTRESS, 'ESCALATED_DISTRESS');
  });
});

describe('EscalationAlertPlugin fires on ESCALATED_DISTRESS the same way as ESCALATED_SYMPTOM', () => {
  function makeRepo() {
    return { alerts: [], async recordAlert(callId, channel) { this.alerts.push({ callId, channel }); } };
  }
  function makeSender() {
    const sent = [];
    return { sent, send: async (recipient, text) => { sent.push({ recipient, text }); } };
  }
  const CALL = {
    callId: 'call-distress-1',
    variables: { parent_name: 'रोहन', caregiver_contact: 'caregiver-123' },
  };

  test('tool_call source alerts both operator and caregiver', async () => {
    const repo = makeRepo();
    const sender = makeSender();
    const plugin = new EscalationAlertPlugin({ repository: repo, send: sender.send, operatorContact: 'op-1' });

    await plugin.onEscalation(
      { label: 'ESCALATED_DISTRESS', source: 'tool_call', reason: 'wants to stop treatment' },
      CALL
    );

    const recipients = sender.sent.map((s) => s.recipient);
    assert.ok(recipients.includes('op-1'));
    assert.ok(recipients.includes('caregiver-123'));
  });

  test('keyword_match source alerts the operator only (unvalidated detector)', async () => {
    const repo = makeRepo();
    const sender = makeSender();
    const plugin = new EscalationAlertPlugin({ repository: repo, send: sender.send, operatorContact: 'op-1' });

    await plugin.onEscalation(
      { label: 'ESCALATED_DISTRESS', source: 'keyword_match', reason: 'distress_keyword_detected' },
      CALL
    );

    const recipients = sender.sent.map((s) => s.recipient);
    assert.deepStrictEqual(recipients, ['op-1']);
  });

  test('operator message carries the ESCALATED_DISTRESS label', async () => {
    const repo = makeRepo();
    const sender = makeSender();
    const plugin = new EscalationAlertPlugin({ repository: repo, send: sender.send, operatorContact: 'op-1' });

    await plugin.onEscalation(
      { label: 'ESCALATED_DISTRESS', source: 'tool_call', reason: 'wants to stop treatment' },
      CALL
    );

    const opMsg = sender.sent.find((s) => s.recipient === 'op-1').text;
    assert.ok(opMsg.includes('ESCALATED_DISTRESS'));
  });

  test('caregiver message still makes no clinical claim', async () => {
    const repo = makeRepo();
    const sender = makeSender();
    const plugin = new EscalationAlertPlugin({ repository: repo, send: sender.send, operatorContact: 'op-1' });

    await plugin.onEscalation(
      { label: 'ESCALATED_DISTRESS', source: 'tool_call', reason: 'wants to stop treatment' },
      CALL
    );

    const caregiverMsg = sender.sent.find((s) => s.recipient === 'caregiver-123').text;
    for (const leak of ['distress', 'self-harm', 'ESCALATED']) {
      assert.ok(!caregiverMsg.toLowerCase().includes(leak.toLowerCase()),
        `caregiver message leaked "${leak}": ${caregiverMsg}`);
    }
  });
});
