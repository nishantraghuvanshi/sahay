'use strict';

/**
 * Escalation alert tests (PILOT-PLAN.md §2.3–2.5).
 *
 * The behaviour under test is a safety decision, not a feature:
 * an unvalidated keyword heuristic must not page a family at 2am, and a
 * failed alert must never be swallowed.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const EscalationAlertPlugin = require('../src/use-cases/medication-adherence/plugins/escalation-alert');

function makeRepo() {
  return {
    alerts: [],
    async recordAlert(callId, channel) { this.alerts.push({ callId, channel }); },
  };
}

function makeSender() {
  const sent = [];
  const send = async (recipient, text) => { sent.push({ recipient, text }); };
  return { sent, send };
}

const CALL = {
  callId: 'call-1',
  variables: { parent_name: 'रोहन', caregiver_contact: 'caregiver-123' },
};

let repo;
let sender;

beforeEach(() => {
  repo = makeRepo();
  sender = makeSender();
});

describe('suppression rule — unvalidated detector must not page the family', () => {
  test('keyword_match alerts the operator only', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo, send: sender.send, operatorContact: 'op-1',
    });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'keyword_match', reason: 'symptom_keyword_detected' },
      CALL
    );

    const recipients = sender.sent.map((s) => s.recipient);
    assert.deepStrictEqual(recipients, ['op-1'], 'caregiver was paged by a keyword match');
  });

  test('tool_call alerts both operator and caregiver', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo, send: sender.send, operatorContact: 'op-1',
    });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'user reported chest pain' },
      CALL
    );

    const recipients = sender.sent.map((s) => s.recipient);
    assert.ok(recipients.includes('op-1'));
    assert.ok(recipients.includes('caregiver-123'));
  });
});

describe('message content', () => {
  test('caregiver message makes no medical claim and names no symptom', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo, send: sender.send, operatorContact: 'op-1',
    });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'user reported chest pain' },
      CALL
    );

    const caregiverMsg = sender.sent.find((s) => s.recipient === 'caregiver-123').text;
    for (const leak of ['chest pain', 'symptom', 'ESCALATED']) {
      assert.ok(!caregiverMsg.toLowerCase().includes(leak.toLowerCase()),
        `caregiver message leaked "${leak}": ${caregiverMsg}`);
    }
    assert.ok(caregiverMsg.includes('रोहन'), 'caregiver message should name the parent');
  });

  test('operator message carries the diagnostic detail', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo, send: sender.send, operatorContact: 'op-1',
    });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'user reported chest pain' },
      CALL
    );

    const opMsg = sender.sent.find((s) => s.recipient === 'op-1').text;
    assert.ok(opMsg.includes('call-1'));
    assert.ok(opMsg.includes('tool_call'));
    assert.ok(opMsg.includes('chest pain'));
  });
});

describe('non-escalation outcomes do not alert', () => {
  for (const label of ['CONFIRMED', 'DENIED', 'UNCLEAR', 'INCOMPLETE', 'NO_ANSWER']) {
    test(`${label} sends nothing`, async () => {
      const plugin = new EscalationAlertPlugin({
        repository: repo, send: sender.send, operatorContact: 'op-1',
      });
      await plugin.onEscalation({ label, source: 'tool_call', reason: 'x' }, CALL);
      assert.strictEqual(sender.sent.length, 0);
    });
  }
});

describe('failure handling — a dropped medical alert must be visible', () => {
  test('records "failed" when every send throws', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo,
      send: async () => { throw new Error('network down'); },
      operatorContact: 'op-1',
      retries: 1,
    });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'fever' },
      CALL
    );

    assert.deepStrictEqual(repo.alerts, [{ callId: 'call-1', channel: 'failed' }]);
  });

  test('does not throw out of the hook when sending fails', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo,
      send: async () => { throw new Error('network down'); },
      operatorContact: 'op-1',
      retries: 1,
    });

    await assert.doesNotReject(() => plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'fever' }, CALL
    ));
  });

  test('records "none" when no transport is configured', async () => {
    const plugin = new EscalationAlertPlugin({ repository: repo, send: null, operatorContact: null });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'fever' }, CALL
    );

    assert.deepStrictEqual(repo.alerts, [{ callId: 'call-1', channel: 'none' }]);
  });

  test('records the channel on a successful send', async () => {
    const plugin = new EscalationAlertPlugin({
      repository: repo, send: sender.send, operatorContact: 'op-1', channel: 'telegram',
    });

    await plugin.onEscalation(
      { label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'fever' }, CALL
    );

    assert.deepStrictEqual(repo.alerts, [{ callId: 'call-1', channel: 'telegram' }]);
  });
});

describe('plugin contract', () => {
  test('has a name so the registry accepts it', () => {
    assert.strictEqual(new EscalationAlertPlugin().name, 'escalation-alert');
  });
});
