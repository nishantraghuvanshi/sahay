'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { terminalStatusFor } = require('../src/core/inbound/session-status');
const SqliteRepository = require('../src/adapters/persistence/sqlite');

const tmpDbs = [];

/** Fresh on-disk database per test — no shared state between cases. */
function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-session-lifecycle-')),
    'test.db'
  );
  tmpDbs.push(dbPath);
  return new SqliteRepository({ dbPath });
}

after(() => {
  for (const p of tmpDbs) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe('terminalStatusFor', () => {
  test('returns completed for each normal ended reason', () => {
    assert.strictEqual(terminalStatusFor('customer-ended-call'), 'completed');
    assert.strictEqual(terminalStatusFor('assistant-ended-call'), 'completed');
    assert.strictEqual(
      terminalStatusFor('assistant-ended-call-with-hangup-task'),
      'completed'
    );
  });

  test('returns completed for an assistant-initiated hangup reason', () => {
    assert.strictEqual(terminalStatusFor('assistant-forwarded-call-hangup'), 'completed');
  });

  test('returns dropped for a network error', () => {
    assert.strictEqual(terminalStatusFor('pipeline-error-network'), 'dropped');
  });

  test('returns dropped for customer-did-not-answer', () => {
    assert.strictEqual(terminalStatusFor('customer-did-not-answer'), 'dropped');
  });

  test('returns dropped for an undefined reason', () => {
    assert.strictEqual(terminalStatusFor(undefined), 'dropped');
  });

  test('returns dropped for an unrecognised reason', () => {
    assert.strictEqual(terminalStatusFor('something-nobody-has-seen-before'), 'dropped');
  });
});

describe('session termination integration', () => {
  test('terminalStatusFor + endSession stores the decided status', async () => {
    const repo = freshRepo();
    await repo.createSession({ sessionId: 'call-completed-1', patientId: null });

    const status = terminalStatusFor('customer-ended-call');
    await repo.endSession('call-completed-1', status);

    const session = await repo.getSession('call-completed-1');
    assert.strictEqual(session.status, 'completed');
    assert.ok(session.ended_at, 'ended_at should be set');
  });

  test('an unknown reason ends the session as dropped, not completed', async () => {
    const repo = freshRepo();
    await repo.createSession({ sessionId: 'call-dropped-1', patientId: null });

    const status = terminalStatusFor('some-new-reason-vapi-added');
    await repo.endSession('call-dropped-1', status);

    const session = await repo.getSession('call-dropped-1');
    assert.strictEqual(session.status, 'dropped');
  });

  test('ending a session that does not exist throws Unknown session', async () => {
    const repo = freshRepo();
    await assert.rejects(
      () => repo.endSession('no-such-call', terminalStatusFor(undefined)),
      /Unknown session/
    );
  });
});
