'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PlaygroundConversation } = require('../src/playground/conversation');
const PlaygroundTransportAdapter = require('../src/adapters/transport/playground');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

/**
 * Task 3 — PlaygroundConversation's wiring to the shared lifecycle module.
 *
 * playground-transport.test.js proves the transport itself drives
 * open/capture/close correctly (the direct equivalent of resume-e2e.test.js).
 * This file proves PlaygroundConversation actually calls that transport at
 * the right moments: capture_field tool calls from the LLM reach
 * transport.captureField, and ending the conversation reaches
 * transport.closeSession with the right terminal status.
 *
 * STT/LLM/TTS are stubbed — no real provider calls — so this is entirely
 * about the wiring, not the speech pipeline. Turns are driven through
 * turn.userTranscript(), same as a real transcript would, rather than
 * calling private methods directly, so the turn manager's own state
 * machine is exercised too, not bypassed.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-playground-conversation-')),
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

const PATIENT = { phone: '+919876500055', name: 'Rekha-ji', drugName: 'Losartan', language: 'hi' };

/** A TTS adapter implementing only TTSPort's blocking synthesize() — no streaming API. */
function fakeBlockingTTS() {
  return { synthesize: async () => Buffer.from([0, 0]) };
}

/** Minimal provider registry stub — no real STT/LLM/TTS calls. */
function fakeProviderRegistry(llmResponses) {
  let callIndex = 0;
  return {
    getActiveSTT: () => ({ init: async () => {}, transcribe: async () => {}, dispose: async () => {} }),
    getSTTConfig: () => ({}),
    getActiveLLM: () => ({
      chatCompletionStream: async (body, config, env, onToken) => {
        const response = llmResponses[Math.min(callIndex, llmResponses.length - 1)];
        callIndex++;
        onToken(response.content || '');
        return response;
      },
    }),
    getLLMConfig: () => ({}),
    getActivePlaygroundTTS: () => fakeBlockingTTS(),
    getTTSConfig: () => ({}),
  };
}

/**
 * Poll a predicate until it's true or a timeout elapses.
 *
 * The turn manager and PlaygroundConversation both drive their callbacks
 * fire-and-forget (matching production — the turn manager never awaits
 * onAgentSpeak/onProcessUserSpeech), so a caller in these tests must poll
 * rather than assume a single microtask suffices.
 *
 * @param {Function} predicate - () => boolean|Promise<boolean>
 * @param {number} [timeoutMs=1000]
 */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: condition never became true');
}

function buildConversation({ repo, llmResponses, direction = 'inbound', callbacks = {} }) {
  const transport = new PlaygroundTransportAdapter(null);
  transport.repository = repo;

  const conversation = new PlaygroundConversation({
    providerRegistry: fakeProviderRegistry(llmResponses),
    strategy: new MedicationAdherenceStrategy('hi'),
    transport,
    language: 'hi',
    phone: PATIENT.phone,
    direction,
    onAudio: () => {},
    onAgentResponse: () => {},
    onOutcome: callbacks.onOutcome || (() => {}),
    onModeResolved: callbacks.onModeResolved || (() => {}),
    onError: callbacks.onError || ((err) => { throw err; }),
  });

  return { conversation, transport };
}

describe('PlaygroundConversation — capture_field wiring', () => {
  test('a capture_field tool call from the LLM reaches the repository via the transport', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    const { conversation } = buildConversation({
      repo,
      llmResponses: [
        {
          content: 'ठीक है',
          tool_calls: [
            { function: { name: 'capture_field', arguments: JSON.stringify({ field: 'chief_complaint', value: 'बुखार है' }) } },
          ],
        },
      ],
    });

    await conversation.start();
    assert.ok(conversation.sessionId, 'a session should have been opened');
    await waitFor(() => conversation.turn.getState() === 'listening');

    conversation.turn.userTranscript('मुझे बुखार है', true);

    await waitFor(async () => (await repo.getSessionFields(conversation.sessionId)).chief_complaint !== undefined);
    const fields = await repo.getSessionFields(conversation.sessionId);
    assert.strictEqual(fields.chief_complaint, 'बुखार है');

    await conversation.stop(); // release the turn manager's pending timers
  });
});

describe('PlaygroundConversation — session close on conversation end', () => {
  test('a real report_outcome closes the session as completed', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    const { conversation } = buildConversation({
      repo,
      llmResponses: [
        {
          content: 'धन्यवाद, अलविदा',
          tool_calls: [
            { function: { name: 'report_outcome', arguments: JSON.stringify({ outcome: 'CONFIRMED', reason: 'user confirmed' }) } },
          ],
        },
      ],
    });

    await conversation.start();
    const sessionId = conversation.sessionId;
    await waitFor(() => conversation.turn.getState() === 'listening');

    conversation.turn.userTranscript('हाँ ले ली दवाई', true);

    // report_outcome's farewell is spoken via a fire-and-forget _speak()
    // call, which is what drives ttsFinished → the outcome → the close —
    // poll until it lands rather than assuming a fixed number of ticks.
    await waitFor(async () => {
      const session = await repo.getSession(sessionId);
      return session.status !== 'active';
    });

    const session = await repo.getSession(sessionId);
    assert.strictEqual(session.status, 'completed');
  });

  test('stop() (browser disconnect or manual stop) closes the session as dropped', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    const { conversation } = buildConversation({ repo, llmResponses: [{ content: '', tool_calls: [] }] });

    await conversation.start();
    const sessionId = conversation.sessionId;

    await conversation.stop();

    const session = await repo.getSession(sessionId);
    assert.strictEqual(session.status, 'dropped');
  });

  test('a session closed as dropped resumes on the next playground conversation for the same patient', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    const first = buildConversation({ repo, llmResponses: [{ content: 'ठीक है', tool_calls: [
      { function: { name: 'capture_field', arguments: JSON.stringify({ field: 'onset', value: 'कल से' }) } },
    ] }] });
    await first.conversation.start();
    await waitFor(() => first.conversation.turn.getState() === 'listening');
    first.conversation.turn.userTranscript('कल से है', true);
    await waitFor(async () => (await repo.getSessionFields(first.conversation.sessionId)).onset !== undefined);
    await first.conversation.stop();

    let resolvedMode;
    const second = buildConversation({
      repo,
      llmResponses: [{ content: '', tool_calls: [] }],
      callbacks: { onModeResolved: (mode) => { resolvedMode = mode; } },
    });
    await second.conversation.start();

    assert.strictEqual(resolvedMode, 'resume');

    await second.conversation.stop(); // release the turn manager's pending timers
  });
});
