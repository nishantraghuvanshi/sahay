'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const SqliteRepository = require('../src/adapters/persistence/sqlite');

// Use a temp directory for test databases
let tmpDir;
let dbPath;
let repo;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  repo = new SqliteRepository({ dbPath });
});

afterEach(async () => {
  if (repo) {
    await repo.close();
    repo = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('SqliteRepository — schema migration', () => {
  it('creates tables on construction', () => {
    // If we got here without throwing, migration succeeded
    assert.ok(repo.db);
  });

  it('is idempotent — can construct twice on same file', () => {
    const repo2 = new SqliteRepository({ dbPath });
    assert.ok(repo2.db);
    repo2.close();
  });

  it('creates the data directory if it does not exist', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'dir', 'test.db');
    const repo2 = new SqliteRepository({ dbPath: nestedPath });
    assert.ok(fs.existsSync(path.dirname(nestedPath)));
    repo2.close();
  });
});

describe('SqliteRepository — createCall', () => {
  it('inserts a call record', async () => {
    await repo.createCall({
      callId: 'test-1',
      useCase: 'medication-adherence',
      language: 'hi',
      phone: '+919999999999',
      variables: { parent_name: 'Test', drug_name: 'Aspirin' },
    });

    const call = await repo.getCall('test-1');
    assert.ok(call);
    assert.equal(call.call_id, 'test-1');
    assert.equal(call.use_case, 'medication-adherence');
    assert.equal(call.language, 'hi');
    assert.equal(call.phone, '+919999999999');
    assert.ok(call.variables);
    const vars = JSON.parse(call.variables);
    assert.equal(vars.parent_name, 'Test');
  });

  it('handles null optional fields', async () => {
    await repo.createCall({ callId: 'test-2' });
    const call = await repo.getCall('test-2');
    assert.ok(call);
    assert.equal(call.call_id, 'test-2');
    assert.equal(call.use_case, null);
    assert.equal(call.phone, null);
  });
});

describe('SqliteRepository — save outcome', () => {
  it('updates a call with outcome data', async () => {
    await repo.createCall({ callId: 'test-3' });
    await repo.save({
      callId: 'test-3',
      label: 'CONFIRMED',
      source: 'tool_call',
      reason: 'user_confirmed',
      transcript: 'User said yes',
      duration: 45.5,
      cost: 0.12,
    });

    const call = await repo.getCall('test-3');
    assert.equal(call.outcome_label, 'CONFIRMED');
    assert.equal(call.outcome_source, 'tool_call');
    assert.equal(call.outcome_reason, 'user_confirmed');
    assert.equal(call.transcript, 'User said yes');
    assert.equal(call.duration_seconds, 45.5);
    assert.equal(call.cost, 0.12);
    assert.ok(call.ended_at);
  });

  it('handles partial outcome data', async () => {
    await repo.createCall({ callId: 'test-4' });
    await repo.save({
      callId: 'test-4',
      label: 'NO_ANSWER',
    });

    const call = await repo.getCall('test-4');
    assert.equal(call.outcome_label, 'NO_ANSWER');
    assert.equal(call.transcript, null);
  });
});

describe('SqliteRepository — list', () => {
  it('returns calls ordered by created_at DESC', async () => {
    await repo.createCall({ callId: 'call-a' });
    await repo.createCall({ callId: 'call-b' });
    await repo.createCall({ callId: 'call-c' });

    const calls = await repo.list();
    assert.equal(calls.length, 3);
    // Most recent first
    assert.equal(calls[0].call_id, 'call-c');
    assert.equal(calls[2].call_id, 'call-a');
  });

  it('filters by outcome label', async () => {
    await repo.createCall({ callId: 'call-1' });
    await repo.createCall({ callId: 'call-2' });
    await repo.save({ callId: 'call-1', label: 'CONFIRMED' });
    await repo.save({ callId: 'call-2', label: 'DENIED' });

    const confirmed = await repo.list({ outcome: 'CONFIRMED' });
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].call_id, 'call-1');
  });

  it('filters by phone', async () => {
    await repo.createCall({ callId: 'call-x', phone: '+911111111111' });
    await repo.createCall({ callId: 'call-y', phone: '+912222222222' });

    const calls = await repo.list({ phone: '+911111111111' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].call_id, 'call-x');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.createCall({ callId: `call-limit-${i}` });
    }

    const calls = await repo.list({ limit: 3 });
    assert.equal(calls.length, 3);
  });
});

describe('SqliteRepository — messages', () => {
  it('saves and retrieves conversation messages', async () => {
    await repo.createCall({ callId: 'msg-test' });
    await repo.saveMessage({ callId: 'msg-test', role: 'system', content: 'You are a helpful assistant.' });
    await repo.saveMessage({ callId: 'msg-test', role: 'user', content: 'नमस्ते' });
    await repo.saveMessage({ callId: 'msg-test', role: 'assistant', content: 'नमस्ते! कैसे हैं आप?' });

    const messages = await repo.getMessages('msg-test');
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[1].content, 'नमस्ते');
  });

  it('saves tool calls as JSON', async () => {
    await repo.createCall({ callId: 'tc-test' });
    const toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED"}' } }];
    await repo.saveMessage({ callId: 'tc-test', role: 'assistant', content: null, toolCalls });

    const messages = await repo.getMessages('tc-test');
    assert.equal(messages.length, 1);
    const saved = JSON.parse(messages[0].tool_calls);
    assert.equal(saved[0].function.name, 'report_outcome');
  });

  it('returns empty array for unknown callId', async () => {
    const messages = await repo.getMessages('nonexistent');
    assert.equal(messages.length, 0);
  });
});

describe('SqliteRepository — getCall', () => {
  it('returns null for unknown callId', async () => {
    const call = await repo.getCall('does-not-exist');
    assert.equal(call, null);
  });
});

describe('SqliteRepository — close', () => {
  it('closes the database connection', async () => {
    await repo.close();
    // Accessing db after close should throw or return null
    assert.equal(repo.db, null);
  });
});
