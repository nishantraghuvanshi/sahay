'use strict';

/**
 * Persistence tests for the pilot measurement plan (PILOT-PLAN.md §5).
 *
 * The first test here covers a silent data-loss bug: save() was an UPDATE,
 * and nothing in the engine ever called createCall() to insert the row first,
 * so every outcome was written to zero rows and discarded without an error.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SqliteRepository = require('../src/adapters/persistence/sqlite');

let dbPath;
let repo;

before(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'va-pilot-')), 'test.db');
  repo = new SqliteRepository({ dbPath });
});

after(() => {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('save() persists without a prior createCall()', () => {
  test('an outcome saved for an unknown call_id is still stored', async () => {
    await repo.save({
      callId: 'call-no-precreate',
      label: 'CONFIRMED',
      source: 'tool_call',
      reason: 'user confirmed',
      transcript: 'haan le liya',
      duration: 42,
      cost: 0.05,
    });

    const row = await repo.getCall('call-no-precreate');
    assert.ok(row, 'outcome was silently discarded — no row written');
    assert.strictEqual(row.outcome_label, 'CONFIRMED');
    assert.strictEqual(row.outcome_source, 'tool_call');
  });

  test('save() after createCall() updates rather than duplicating', async () => {
    await repo.createCall({
      callId: 'call-precreated',
      useCase: 'medication-adherence',
      language: 'hi',
      phone: '+911234567890',
      variables: { parent_name: 'रोहन' },
    });
    await repo.save({ callId: 'call-precreated', label: 'DENIED', source: 'tool_call', reason: 'not yet' });

    const all = await repo.list({ limit: 500 });
    const matches = all.filter((c) => c.call_id === 'call-precreated');
    assert.strictEqual(matches.length, 1, 'upsert created a duplicate row');
    assert.strictEqual(matches[0].outcome_label, 'DENIED');
    assert.strictEqual(matches[0].phone, '+911234567890', 'createCall metadata was clobbered');
  });
});

describe('pilot measurement columns (§5)', () => {
  test('all pilot columns exist on the calls table', () => {
    const cols = repo.db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name);
    for (const col of [
      'prompt_version', 'parent_id', 'attempt_number',
      'alert_sent_at', 'alert_channel', 'ground_truth',
    ]) {
      assert.ok(cols.includes(col), `missing column: ${col}`);
    }
  });

  test('prompt_version and parent_id round-trip through save()', async () => {
    await repo.save({
      callId: 'call-metrics',
      label: 'ESCALATED_SYMPTOM',
      source: 'keyword_match',
      reason: 'symptom_keyword_detected',
      promptVersion: '2',
      parentId: 'parent-01',
      attemptNumber: 2,
    });

    const row = await repo.getCall('call-metrics');
    assert.strictEqual(row.prompt_version, '2');
    assert.strictEqual(row.parent_id, 'parent-01');
    assert.strictEqual(row.attempt_number, 2);
  });

  test('recordAlert() stamps delivery for escalation latency', async () => {
    await repo.save({ callId: 'call-alert', label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'chest pain' });
    await repo.recordAlert('call-alert', 'telegram');

    const row = await repo.getCall('call-alert');
    assert.strictEqual(row.alert_channel, 'telegram');
    assert.ok(row.alert_sent_at, 'alert_sent_at not stamped');
  });

  test('recordAlert() records a failed send rather than losing it', async () => {
    await repo.save({ callId: 'call-alert-fail', label: 'ESCALATED_SYMPTOM', source: 'tool_call', reason: 'fever' });
    await repo.recordAlert('call-alert-fail', 'failed');

    const row = await repo.getCall('call-alert-fail');
    assert.strictEqual(row.alert_channel, 'failed');
  });
});

describe('engine ordering — alert stamps must survive persistence', () => {
  test('alert_sent_at is recorded on the stored row', async () => {
    const ConversationEngine = require('../src/core/engine/engine');
    const PluginRegistry = require('../src/core/plugins/registry');
    const Strategy = require('../src/use-cases/medication-adherence/strategy');
    const EscalationAlertPlugin = require('../src/use-cases/medication-adherence/plugins/escalation-alert');
    const { EVENT_TYPES } = require('../src/core/engine/event-bus');

    const plugins = new PluginRegistry();
    plugins.register(new EscalationAlertPlugin({
      repository: repo, send: async () => {}, operatorContact: 'op-1', channel: 'telegram',
    }));
    const engine = new ConversationEngine({ strategy: new Strategy(), plugins, repository: repo });

    await engine.getEventBus().emit(EVENT_TYPES.CONVERSATION_ENDED, {
      callData: {
        callId: 'ordering-1',
        toolCalls: [{ name: 'report_outcome', arguments: { outcome: 'ESCALATED_SYMPTOM', reason: 'chest pain' } }],
        variables: { parent_name: 'रोहन', caregiver_contact: 'cg-1' },
      },
    });

    const row = await repo.getCall('ordering-1');
    assert.strictEqual(row.outcome_label, 'ESCALATED_SYMPTOM');
    assert.strictEqual(row.alert_channel, 'telegram', 'alert stamp was lost — save() ran after the alert');
    assert.ok(row.alert_sent_at, 'alert_sent_at not recorded');
    assert.strictEqual(row.prompt_version, '2');
  });
});
