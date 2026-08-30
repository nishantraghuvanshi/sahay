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

    conversation.turn.silenceDetected();

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

    conversation.turn.silenceDetected();

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

  test('stop() actually awaits the session close before resolving (F4)', async () => {
    // The test above passes even with a fire-and-forget close, because the
    // fake repository's writes are synchronous under the hood and happen to
    // settle before the assertion runs. That's exactly the gap: a
    // disconnect immediately followed by process shutdown wouldn't get that
    // lucky. This makes the close artificially slow and proves stop()'s own
    // promise does not resolve until it does — a browser disconnect must
    // never be able to leave a session 'active' (unresumable) because the
    // process moved on before the write landed.
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    const { conversation } = buildConversation({ repo, llmResponses: [{ content: '', tool_calls: [] }] });

    await conversation.start();
    const sessionId = conversation.sessionId;

    const originalEndSession = repo.endSession.bind(repo);
    let releaseClose;
    const closeGate = new Promise((resolve) => { releaseClose = resolve; });
    repo.endSession = async (...args) => {
      await closeGate;
      return originalEndSession(...args);
    };

    let stopResolved = false;
    const stopPromise = conversation.stop().then(() => { stopResolved = true; });

    // Let every fire-and-forget microtask that would run anyway have its
    // turn. If stop() didn't await the close, it would have resolved by now.
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(stopResolved, false, 'stop() must not resolve before the session close completes');
    assert.strictEqual((await repo.getSession(sessionId)).status, 'active', 'the close is still pending');

    releaseClose();
    await stopPromise;

    assert.strictEqual(stopResolved, true);
    assert.strictEqual((await repo.getSession(sessionId)).status, 'dropped');
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
    first.conversation.turn.silenceDetected();
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

describe('PlaygroundConversation — TTS adapter identity (F7)', () => {
  test('the same TTS adapter instance is reused for the life of a conversation', async () => {
    // ProviderRegistry.getPlaygroundAdapter() mints a NEW adapter instance
    // on every call (correctly — it's a singleton shared by every concurrent
    // playground conversation, and must not let one leak into another's).
    // But onCancelTTS, _speak, _processUserSpeech and stop() all need to
    // reach the SAME instance within one conversation, or a streaming
    // adapter's disconnectStream() acts on an instance that was never
    // connected — barge-in silently does nothing. This fakes the registry
    // exactly as reported (a fresh object per call) and asserts
    // PlaygroundConversation caches its own reference rather than trusting
    // the registry to hand back the same one.
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);

    let instancesCreated = 0;
    const registry = {
      getActiveSTT: () => ({ init: async () => {}, transcribe: async () => {}, dispose: async () => {} }),
      getSTTConfig: () => ({}),
      getActiveLLM: () => ({
        chatCompletionStream: async (body, config, env, onToken) => {
          onToken('');
          return { content: '', tool_calls: [] };
        },
      }),
      getLLMConfig: () => ({}),
      getTTSConfig: () => ({}),
      getActivePlaygroundTTS: () => {
        instancesCreated++;
        return { synthesize: async () => Buffer.from([0, 0]) };
      },
    };

    const transport = new PlaygroundTransportAdapter(null);
    transport.repository = repo;

    const conversation = new PlaygroundConversation({
      providerRegistry: registry,
      strategy: new MedicationAdherenceStrategy('hi'),
      transport,
      language: 'hi',
      phone: PATIENT.phone,
      direction: 'inbound',
      onAudio: () => {},
      onAgentResponse: () => {},
      onError: (err) => { throw err; },
    });

    // First fetch happens as part of speaking the first message (start()).
    await conversation.start();
    await waitFor(() => conversation.turn.getState() === 'listening');

    // Drive one more turn (fetches the adapter again in _processUserSpeech),
    // then simulate a browser disconnect (fetches it again in stop()).
    conversation.turn.userTranscript('नमस्ते', true);
    conversation.turn.silenceDetected();
    await waitFor(() => conversation.turn.getState() === 'listening');
    await conversation.stop();

    assert.strictEqual(
      instancesCreated,
      1,
      'the registry should be asked for the TTS adapter exactly once per conversation, not once per call site'
    );
  });
});
