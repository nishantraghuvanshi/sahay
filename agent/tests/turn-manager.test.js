'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { TurnManager, STATE } = require('../src/playground/turn-manager');

/**
 * Create a TurnManager with fake timers and a recorder that captures
 * all callback invocations in order.
 */
function makeTurn(overrides = {}) {
  const calls = [];
  const tm = new TurnManager({
    silenceTimeoutMs: 100,
    endpointSilenceMs: 50,
    maxSpeechDurationMs: 200,
    retryPromptText: 'are you there?',
    onStateChange: (o, n) => calls.push({ cb: 'onStateChange', args: [o, n] }),
    onAgentSpeak: (t) => calls.push({ cb: 'onAgentSpeak', args: [t] }),
    onCancelTTS: () => calls.push({ cb: 'onCancelTTS', args: [] }),
    onStartListening: () => calls.push({ cb: 'onStartListening', args: [] }),
    onStopListening: () => calls.push({ cb: 'onStopListening', args: [] }),
    onProcessUserSpeech: (t) => calls.push({ cb: 'onProcessUserSpeech', args: [t] }),
    onEndConversation: (o) => calls.push({ cb: 'onEndConversation', args: [o] }),
    onError: (e) => calls.push({ cb: 'onError', args: [e] }),
    ...overrides,
  });
  return { tm, calls };
}

/**
 * Drive one finished utterance the way the browser does: STT's final
 * transcript, then the VAD reporting that the speaker has stopped.
 *
 * A final on its own is no longer an endpoint — STT emits one at every pause,
 * and answering the first one talked over the second half of the sentence.
 * See TurnManager.userTranscript.
 */
function saysAndStops(tm, text) {
  tm.userTranscript(text, true);
  tm.silenceDetected();
}

describe('TurnManager — basic flow', () => {
  test('start → speak first message, then listen after TTS', () => {
    const { tm, calls } = makeTurn();
    tm.start('नमस्ते');

    assert.strictEqual(tm.getState(), STATE.SPEAKING);
    assert.deepStrictEqual(calls, [
      { cb: 'onStateChange', args: [STATE.IDLE, STATE.SPEAKING] },
      { cb: 'onAgentSpeak', args: ['नमस्ते'] },
    ]);

    tm.ttsFinished();
    assert.strictEqual(tm.getState(), STATE.LISTENING);
    // After TTS, should start listening
    const lastCalls = calls.slice(-2);
    assert.deepStrictEqual(lastCalls[0], { cb: 'onStateChange', args: [STATE.SPEAKING, STATE.LISTENING] });
    assert.deepStrictEqual(lastCalls[1], { cb: 'onStartListening', args: [] });
  });

  test('start with empty message goes straight to listening', () => {
    const { tm, calls } = makeTurn();
    tm.start('');
    assert.strictEqual(tm.getState(), STATE.LISTENING);
    assert.ok(calls.some(c => c.cb === 'onStartListening'));
  });

  test('start with no message goes straight to listening', () => {
    const { tm } = makeTurn();
    tm.start();
    assert.strictEqual(tm.getState(), STATE.LISTENING);
  });
});

describe('TurnManager — endpointing', () => {
  test('a final transcript plus the VAD stopping triggers processing', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    tm.userTranscript('hello world', true);
    // Still listening: STT emits a final at every pause, and the speaker may
    // not be finished. The VAD is what says they are.
    assert.strictEqual(tm.getState(), STATE.LISTENING);

    tm.silenceDetected();

    assert.strictEqual(tm.getState(), STATE.PROCESSING);
    assert.deepStrictEqual(calls, [
      { cb: 'onStopListening', args: [] },
      { cb: 'onStateChange', args: [STATE.LISTENING, STATE.PROCESSING] },
      { cb: 'onProcessUserSpeech', args: ['hello world'] },
    ]);
  });

  test('a sentence split across two finals is sent whole, not halved', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    // "हाँ" … pause … "मैंने दवाई ले ली" — one answer, two finals.
    tm.userTranscript('हाँ', true);
    tm.userTranscript('मैंने दवाई ले ली', true);
    tm.silenceDetected();

    assert.strictEqual(tm.getState(), STATE.PROCESSING);
    assert.deepStrictEqual(
      calls.filter((c) => c.cb === 'onProcessUserSpeech'),
      [{ cb: 'onProcessUserSpeech', args: ['हाँ मैंने दवाई ले ली'] }],
    );
  });

  test('a final that arrives after the VAD already stopped is answered at once', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    // STT lags the VAD: the silence signal lands first, then the transcript.
    tm.userTranscript('हाँ', false);
    tm.silenceDetected();
    assert.strictEqual(tm.getState(), STATE.LISTENING);

    tm.userTranscript('हाँ ले ली', true);
    assert.strictEqual(tm.getState(), STATE.PROCESSING);
    assert.ok(calls.some((c) => c.cb === 'onProcessUserSpeech' && c.args[0] === 'हाँ ले ली'));
  });

  test('empty final transcript is ignored', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    const stateBefore = tm.getState();
    tm.userTranscript('', true);
    assert.strictEqual(tm.getState(), stateBefore);
  });

  test('partial transcript updates buffer and resets endpoint timer', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    tm.userTranscript('hello', false);
    assert.strictEqual(tm.lastPartialTranscript, 'hello');
    assert.ok(tm.speechStarted, 'speech should be started');
  });

  test('endpoint silence timer fires with last partial', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    // Partial transcript, then silence
    tm.userTranscript('partial text', false);
    tm.silenceDetected();

    // Advance fake timers — endpointSilenceMs is 50ms
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(tm.getState(), STATE.PROCESSING);
        assert.ok(calls.some(c => c.cb === 'onProcessUserSpeech' && c.args[0] === 'partial text'));
        resolve();
      }, 80);
    });
  });

  test('max speech duration forces endpoint', () => {
    const { tm, calls } = makeTurn({ maxSpeechDurationMs: 30 });
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    tm.userTranscript('long speech', false);

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(tm.getState(), STATE.PROCESSING);
        assert.ok(calls.some(c => c.cb === 'onProcessUserSpeech' && c.args[0] === 'long speech'));
        resolve();
      }, 60);
    });
  });
});

describe('TurnManager — barge-in', () => {
  test('barge-in during SPEAKING cancels TTS and starts listening', () => {
    const { tm, calls } = makeTurn();
    tm.start('hello');
    calls.length = 0;

    tm.bargeIn();

    assert.strictEqual(tm.getState(), STATE.LISTENING);
    assert.deepStrictEqual(calls, [
      { cb: 'onCancelTTS', args: [] },
      { cb: 'onStateChange', args: [STATE.SPEAKING, STATE.LISTENING] },
      { cb: 'onStartListening', args: [] },
    ]);
  });

  test('barge-in during PROCESSING sets pending flag', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');
    assert.strictEqual(tm.getState(), STATE.PROCESSING);

    tm.bargeIn();
    assert.strictEqual(tm.bargeInPending, true);
  });

  test('LLM response with bargeInPending skips TTS, goes to listening', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');
    tm.bargeIn();
    calls.length = 0;

    tm.llmResponse('response text', null);

    assert.strictEqual(tm.getState(), STATE.LISTENING);
    assert.strictEqual(tm.bargeInPending, false);
    // Should NOT have called onAgentSpeak
    assert.ok(!calls.some(c => c.cb === 'onAgentSpeak'));
    // Should have started listening
    assert.ok(calls.some(c => c.cb === 'onStartListening'));
  });
});

describe('TurnManager — LLM response', () => {
  test('normal LLM response speaks text', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');
    calls.length = 0;

    tm.llmResponse('answer', null);

    assert.strictEqual(tm.getState(), STATE.SPEAKING);
    assert.deepStrictEqual(calls, [
      { cb: 'onStateChange', args: [STATE.PROCESSING, STATE.SPEAKING] },
      { cb: 'onAgentSpeak', args: ['answer'] },
    ]);
  });

  test('report_outcome tool call with no text ends immediately', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');
    calls.length = 0;

    tm.llmResponse(null, [{
      function: { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED","reason":"user said yes"}' },
    }]);

    assert.strictEqual(tm.getState(), STATE.IDLE);
    assert.ok(tm.ended);
    assert.ok(calls.some(c => c.cb === 'onEndConversation' && c.args[0].label === 'CONFIRMED'));
  });

  test('report_outcome with text speaks farewell then ends after TTS', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');
    calls.length = 0;

    tm.llmResponse('Goodbye!', [{
      function: { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED"}' },
    }]);

    assert.strictEqual(tm.getState(), STATE.SPEAKING);
    assert.ok(calls.some(c => c.cb === 'onAgentSpeak' && c.args[0] === 'Goodbye!'));
    assert.ok(!tm.ended, 'should not end until TTS finishes');

    tm.ttsFinished();
    assert.strictEqual(tm.getState(), STATE.IDLE);
    assert.ok(tm.ended);
    assert.ok(calls.some(c => c.cb === 'onEndConversation' && c.args[0].label === 'CONFIRMED'));
  });

  test('report_outcome with bargeInPending ends immediately', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');
    tm.bargeIn();

    tm.llmResponse('Goodbye!', [{
      function: { name: 'report_outcome', arguments: '{"outcome":"CONFIRMED"}' },
    }]);

    assert.strictEqual(tm.getState(), STATE.IDLE);
    assert.ok(tm.ended);
    assert.strictEqual(tm.bargeInPending, false);
  });

  test('no text and no outcome resumes listening', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');

    tm.llmResponse(null, null);

    assert.strictEqual(tm.getState(), STATE.LISTENING);
  });

  test('tool call arguments as object (not string)', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    saysAndStops(tm, 'question');

    tm.llmResponse(null, [{
      function: { name: 'report_outcome', arguments: { outcome: 'DENIED', reason: 'said no' } },
    }]);

    assert.ok(tm.ended);
  });
});

describe('TurnManager — silence timeout', () => {
  test('first silence timeout speaks retry prompt', () => {
    const { tm, calls } = makeTurn({ silenceTimeoutMs: 20 });
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.strictEqual(tm.getState(), STATE.SPEAKING);
        assert.ok(calls.some(c => c.cb === 'onAgentSpeak' && c.args[0] === 'are you there?'));
        assert.ok(!tm.ended);
        resolve();
      }, 40);
    });
  });

  test('second silence timeout ends conversation with NO_ANSWER', () => {
    const { tm, calls } = makeTurn({ silenceTimeoutMs: 20 });
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    return new Promise((resolve) => {
      setTimeout(() => {
        // First timeout should have fired — speak retry, then TTS finishes, listen again
        assert.strictEqual(tm.getState(), STATE.SPEAKING);
        tm.ttsFinished(); // back to listening

        setTimeout(() => {
          // Second timeout — should end
          assert.strictEqual(tm.getState(), STATE.IDLE);
          assert.ok(tm.ended);
          assert.ok(calls.some(c => c.cb === 'onEndConversation' && c.args[0].label === 'NO_ANSWER'));
          resolve();
        }, 40);
      }, 40);
    });
  });

  test('speech detected resets silence timer', () => {
    const { tm } = makeTurn({ silenceTimeoutMs: 20 });
    tm.start('hi');
    tm.ttsFinished();

    return new Promise((resolve) => {
      setTimeout(() => {
        tm.speechDetected(); // should prevent timeout
        setTimeout(() => {
          assert.strictEqual(tm.getState(), STATE.LISTENING);
          assert.ok(!tm.ended);
          resolve();
        }, 30);
      }, 10);
    });
  });
});

describe('TurnManager — stop', () => {
  test('stop ends conversation with STOPPED outcome', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    calls.length = 0;

    tm.stop();

    assert.strictEqual(tm.getState(), STATE.IDLE);
    assert.ok(tm.ended);
    assert.ok(calls.some(c => c.cb === 'onEndConversation' && c.args[0].label === 'STOPPED'));
  });

  test('stop from SPEAKING cancels TTS', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    calls.length = 0;

    tm.stop();

    assert.ok(calls.some(c => c.cb === 'onCancelTTS'));
  });

  test('stop from LISTENING stops listening', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.ttsFinished();
    calls.length = 0;

    tm.stop();

    assert.ok(calls.some(c => c.cb === 'onStopListening'));
  });

  test('stop is idempotent', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.stop();
    const lenAfterStop = calls.length;
    tm.stop();
    assert.strictEqual(calls.length, lenAfterStop);
  });
});

describe('TurnManager — thread safety', () => {
  test('methods after ended are no-ops', () => {
    const { tm, calls } = makeTurn();
    tm.start('hi');
    tm.stop();
    calls.length = 0;

    tm.ttsFinished();
    tm.bargeIn();
    saysAndStops(tm, 'text');
    tm.llmResponse('text', null);
    tm.speechDetected();
    tm.silenceDetected();

    assert.strictEqual(calls.length, 0);
  });

  test('ttsFinished in wrong state is ignored', () => {
    const { tm } = makeTurn();
    tm.start('hi');
    tm.ttsFinished(); // now LISTENING
    const state = tm.getState();
    tm.ttsFinished(); // wrong state
    assert.strictEqual(tm.getState(), state);
  });

  test('userTranscript in wrong state is ignored', () => {
    const { tm } = makeTurn();
    tm.start('hi'); // SPEAKING
    saysAndStops(tm, 'text');
    assert.strictEqual(tm.getState(), STATE.SPEAKING);
  });

  test('llmResponse in wrong state is ignored', () => {
    const { tm } = makeTurn();
    tm.start('hi'); // SPEAKING
    tm.llmResponse('text', null);
    assert.strictEqual(tm.getState(), STATE.SPEAKING);
  });

  test('double start is ignored', () => {
    const { tm } = makeTurn();
    tm.start('first');
    tm.start('second');
    // Should still be speaking first message
  });
});

describe('TurnManager — instantiation', () => {
  test('each instance is independent', () => {
    const { tm: tm1 } = makeTurn();
    const { tm: tm2 } = makeTurn();

    tm1.start('hello');
    assert.strictEqual(tm1.getState(), STATE.SPEAKING);
    assert.strictEqual(tm2.getState(), STATE.IDLE);
  });

  test('uses default config when not provided', () => {
    const tm = new TurnManager({
      onStateChange: () => {},
      onAgentSpeak: () => {},
      onCancelTTS: () => {},
      onStartListening: () => {},
      onStopListening: () => {},
      onProcessUserSpeech: () => {},
      onEndConversation: () => {},
    });
    assert.strictEqual(tm.silenceTimeoutMs, 15000);
    assert.strictEqual(tm.endpointSilenceMs, 1500);
    assert.strictEqual(tm.maxSpeechDurationMs, 30000);
    assert.strictEqual(tm.retryPromptText, 'क्या आप वहाँ हैं?');
  });
});
