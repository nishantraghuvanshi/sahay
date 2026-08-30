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
 * A reply must be spoken ONCE.
 *
 * _processUserSpeech streams the LLM's tokens through a SentenceBuffer and
 * synthesizes each finished sentence as it arrives — that is the whole point of
 * the streaming pipeline, and the caller hears the reply while it is still
 * being generated. It then hands the same text to the turn manager, which used
 * to call onAgentSpeak → _speak → synthesize the entire reply a second time.
 *
 * On a phone call that is a caller hearing every sentence twice. In the browser
 * playground it is worse than annoying: the server stays in SPEAKING for the
 * whole duplicate rendition, and processAudio() drops every microphone frame
 * that is not in LISTENING — so the person talks, and nothing hears them.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-double-speak-')),
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

const PATIENT = { phone: '+919876500077', name: 'Rekha-ji', drugName: 'Losartan', language: 'hi' };

/** Blocking TTS that records every text it is asked to speak. */
function recordingTTS(spoken) {
  return {
    // TTSPort.synthesize takes an options object, not a bare string.
    synthesize: async (options) => {
      spoken.push(options && options.text ? options.text : String(options));
      return Buffer.from([0, 0]);
    },
  };
}

function buildConversation({ repo, spoken, llmResponses }) {
  const transport = new PlaygroundTransportAdapter(null);
  transport.repository = repo;

  return new PlaygroundConversation({
    providerRegistry: {
      getActiveSTT: () => ({ init: async () => {}, transcribe: async () => {}, dispose: async () => {} }),
      getSTTConfig: () => ({}),
      getActiveLLM: () => ({
        chatCompletionStream: async (body, config, env, onToken) => {
          const response = llmResponses.shift() || { content: '', tool_calls: [] };
          onToken(response.content || '');
          return response;
        },
      }),
      getLLMConfig: () => ({}),
      getActivePlaygroundTTS: () => recordingTTS(spoken),
      getTTSConfig: () => ({}),
    },
    strategy: new MedicationAdherenceStrategy('hi'),
    transport,
    language: 'hi',
    phone: PATIENT.phone,
    direction: 'inbound',
    onAudio: () => {},
    onAgentResponse: () => {},
    onError: (err) => { throw err; },
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: condition never became true');
}

/** How many synthesized texts contain this fragment. */
const timesSpoken = (spoken, fragment) =>
  spoken.filter((text) => String(text).includes(fragment)).length;

describe('PlaygroundConversation — a reply is spoken once', () => {
  test('a streamed reply is not synthesized a second time by the turn manager', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const spoken = [];

    const conversation = buildConversation({
      repo,
      spoken,
      llmResponses: [{ content: 'ठीक है, अपना ख़याल रखियेगा।', tool_calls: [] }],
    });

    await conversation.start();
    await waitFor(() => conversation.turn.getState() === 'listening');

    conversation.turn.userTranscript('हाँ ले ली', true);

    conversation.turn.silenceDetected();

    // Back to listening = the whole turn is over, TTS included.
    await waitFor(() => conversation.turn.getState() === 'listening');

    assert.strictEqual(
      timesSpoken(spoken, 'अपना ख़याल रखियेगा'),
      1,
      `the reply was synthesized ${timesSpoken(spoken, 'अपना ख़याल रखियेगा')} times: ${JSON.stringify(spoken)}`
    );

    await conversation.stop();
  });

  test('a farewell before an outcome is also spoken once, and still ends the call', async () => {
    const repo = freshRepo();
    await repo.upsertPatient(PATIENT);
    const spoken = [];

    const outcomes = [];
    const conversation = buildConversation({
      repo,
      spoken,
      llmResponses: [
        {
          content: 'धन्यवाद, नमस्ते।',
          tool_calls: [
            { function: { name: 'report_outcome', arguments: JSON.stringify({ outcome: 'CONFIRMED', reason: 'user confirmed' }) } },
          ],
        },
      ],
    });
    conversation.onOutcome = (outcome) => outcomes.push(outcome);

    await conversation.start();
    const sessionId = conversation.sessionId;
    await waitFor(() => conversation.turn.getState() === 'listening');

    conversation.turn.userTranscript('हाँ ले ली दवाई', true);

    conversation.turn.silenceDetected();

    await waitFor(async () => (await repo.getSession(sessionId)).status !== 'active');

    assert.strictEqual(
      timesSpoken(spoken, 'धन्यवाद'),
      1,
      `the farewell was synthesized ${timesSpoken(spoken, 'धन्यवाद')} times: ${JSON.stringify(spoken)}`
    );
    assert.strictEqual((await repo.getSession(sessionId)).status, 'completed');
  });
});
