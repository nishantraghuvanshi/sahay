'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SqliteRepository = require('../src/adapters/persistence/sqlite');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowids-'));
  return new SqliteRepository({ dbPath: path.join(dir, 'test.db') });
}

describe('row ids', () => {
  test('a created call gets an id', async () => {
    const r = tmpRepo();
    await r.createCall({ callId: 'c1', useCase: 'medication-adherence' });
    const row = r.db.prepare('SELECT id FROM calls WHERE call_id = ?').get('c1');
    assert.ok(row.id, 'calls.id must not be NULL');
  });

  test('saving an outcome for a new call also gets an id', async () => {
    const r = tmpRepo();
    await r.save({ callId: 'c2', label: 'CONFIRMED', source: 'test' });
    const row = r.db.prepare('SELECT id FROM calls WHERE call_id = ?').get('c2');
    assert.ok(row.id, 'calls.id must not be NULL on the save path');
  });

  test('an upsert keeps the id the row already had', async () => {
    const r = tmpRepo();
    await r.createCall({ callId: 'c3' });
    const before = r.db.prepare('SELECT id FROM calls WHERE call_id = ?').get('c3').id;
    await r.save({ callId: 'c3', label: 'CONFIRMED', source: 'test' });
    const after = r.db.prepare('SELECT id FROM calls WHERE call_id = ?').get('c3').id;
    assert.strictEqual(after, before, 'an upsert must not re-key the row');
  });

  test('a session gets an id', async () => {
    const r = tmpRepo();
    await r.upsertPatient({ phone: '+919000000001', name: 'Test' });
    const p = await r.findPatientByPhone('+919000000001');
    await r.createSession({ sessionId: 's1', patientId: p.id, direction: 'out' });
    const row = r.db.prepare('SELECT id FROM sessions WHERE session_id = ?').get('s1');
    assert.ok(row.id, 'sessions.id must not be NULL');
  });
});
