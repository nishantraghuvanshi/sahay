'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const { closeCall } = require('../src/core/call/lifecycle');
const { TurnManager } = require('../src/playground/turn-manager');

/**
 * Ending a call deliberately is not the same event as a call being cut off.
 *
 * The playground used to treat them identically: every Stop click closed the
 * session as `dropped`, which is exactly the state that makes a session
 * resumable — so starting another call within the resume window carried on the
 * previous conversation mid-flow. It looked like leaked state and was actually
 * resume working perfectly on a distinction the code did not draw.
 *
 * The phone path already draws it (session-status.js maps `customer-ended-call`
 * to completed), so this is the playground catching up rather than a new rule.
 */

describe('TurnManager.stop carries why it stopped', () => {
  function managerCapturing(outcomes) {
    return new TurnManager({
      onEndConversation: (o) => { outcomes.push(o); },
      onStartListening() {}, onStopListening() {}, onCancelTTS() {},
      onSpeak() {}, onStateChange() {},
    });
  }

  test('a bare stop is an interruption', () => {
    const outcomes = [];
    managerCapturing(outcomes).stop();
    assert.strictEqual(outcomes[0].source, 'manual');
  });

  test('a deliberate stop says so', () => {
    const outcomes = [];
    managerCapturing(outcomes).stop({ source: 'user_ended', reason: 'stopped_by_user' });
    assert.strictEqual(outcomes[0].source, 'user_ended');
    assert.strictEqual(outcomes[0].reason, 'stopped_by_user');
  });

  test('stop stays idempotent', () => {
    const outcomes = [];
    const tm = managerCapturing(outcomes);
    tm.stop({ source: 'user_ended' });
    tm.stop({ source: 'user_ended' });
    assert.strictEqual(outcomes.length, 1, 'a second stop must not re-end the conversation');
  });
});

describe('what each ending leaves behind', () => {
  let dir;
  let repo;
  let patientId;

  test('setup', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-stop-semantics-'));
    repo = new SqliteRepository({ dbPath: path.join(dir, 'test.db') });
    await repo.upsertPatient({ phone: '+15551230001', name: 'Test', drugName: 'X', language: 'hi' });
    patientId = (await repo.findPatientByPhone('+15551230001')).id;
  });

  async function endSessionWith(id, endedReason) {
    await repo.createCall({ callId: id, useCase: 'medication-adherence', language: 'hi', phone: '+15551230001' });
    await repo.createSession({ sessionId: id, patientId, callId: id, direction: 'inbound' });
    await closeCall({ repository: repo, callId: id, endedReason });
    const sessions = await repo.listSessions({ patientId });
    return sessions.find((s) => s.session_id === id).status;
  }

  test('a deliberate end completes the session', async () => {
    assert.strictEqual(await endSessionWith('s-deliberate', 'customer-ended-call'), 'completed');
  });

  test('an interrupted call stays dropped', async () => {
    assert.strictEqual(await endSessionWith('s-dropped', undefined), 'dropped');
  });

  test('only the interrupted one is offered for resume', async () => {
    // The whole point: a call the person finished must not be resumed, or the
    // next call opens mid-conversation with "we were just speaking".
    const resumable = await repo.findResumableSession(patientId, 15, new Date());
    assert.ok(resumable, 'the dropped session should still be resumable');
    assert.strictEqual(
      resumable.session_id,
      's-dropped',
      'a deliberately ended call was offered for resume'
    );
  });

  test('teardown', () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
