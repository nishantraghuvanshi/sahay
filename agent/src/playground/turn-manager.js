'use strict';

/**
 * Turn Manager
 *
 * A reusable turn-taking state machine for voice conversations. Manages
 * conversation states and transitions without knowing about STT, LLM, or TTS
 * directly — all actions are delegated to callbacks.
 *
 * States:
 *   IDLE       — conversation not started
 *   SPEAKING   — agent is speaking (TTS audio playing to browser)
 *   LISTENING  — mic active, waiting for user speech
 *   PROCESSING — LLM is generating a response
 *
 * Transitions:
 *   IDLE      → SPEAKING   on start(firstMessage)
 *   SPEAKING  → LISTENING  on ttsFinished()
 *   SPEAKING  → LISTENING  on bargeIn()           (cancels TTS)
 *   LISTENING → PROCESSING on userTranscript(final)
 *   LISTENING → SPEAKING   on silenceTimeout()     (retry prompt)
 *   LISTENING → IDLE       on maxSilenceExceeded() (NO_ANSWER)
 *   PROCESSING→ SPEAKING   on llmResponse(text)
 *   PROCESSING→ LISTENING  on llmResponse + bargeInPending
 *   PROCESSING→ IDLE       on outcomeDetected
 *   Any      → IDLE        on stop()
 *
 * The turn manager is instantiable — each conversation gets its own instance.
 * It performs no I/O; every side effect flows through the configured callbacks.
 */

const logger = require('../utils/logger');

/**
 * Conversation states.
 * @readonly
 * @enum {string}
 */
const STATE = {
  IDLE: 'idle',
  SPEAKING: 'speaking',
  LISTENING: 'listening',
  PROCESSING: 'processing',
};

/** @private Default configuration values. */
const DEFAULTS = {
  silenceTimeoutMs: 15000,
  endpointSilenceMs: 1500,
  maxSpeechDurationMs: 30000,
  retryPromptText: 'क्या आप वहाँ हैं?',
};

class TurnManager {
  /**
   * Create a turn manager.
   *
   * @param {Object} config - Configuration and callbacks
   * @param {number} [config.silenceTimeoutMs=15000] - Total silence before retry prompt
   * @param {number} [config.endpointSilenceMs=1500] - Silence after speech that triggers endpoint
   * @param {number} [config.maxSpeechDurationMs=30000] - Force endpoint after this long
   * @param {string} [config.retryPromptText] - Text spoken on silence timeout
   * @param {Function} config.onStateChange - (oldState, newState) => void
   * @param {Function} config.onAgentSpeak - (text) => void — agent should TTS this text
   * @param {Function} config.onCancelTTS - () => void — cancel in-flight TTS
   * @param {Function} config.onStartListening - () => void — start accepting audio for STT
   * @param {Function} config.onStopListening - () => void — stop accepting audio
   * @param {Function} config.onProcessUserSpeech - (transcript) => void — send to LLM
   * @param {Function} config.onEndConversation - (outcome) => void — conversation ended
   * @param {Function} [config.onError] - (err) => void
   */
  constructor(config) {
    // --- Configuration ---
    this.silenceTimeoutMs = config.silenceTimeoutMs ?? DEFAULTS.silenceTimeoutMs;
    this.endpointSilenceMs = config.endpointSilenceMs ?? DEFAULTS.endpointSilenceMs;
    this.maxSpeechDurationMs = config.maxSpeechDurationMs ?? DEFAULTS.maxSpeechDurationMs;
    this.retryPromptText = config.retryPromptText ?? DEFAULTS.retryPromptText;

    // --- Callbacks ---
    this.onStateChange = config.onStateChange || (() => {});
    this.onAgentSpeak = config.onAgentSpeak || (() => {});
    this.onCancelTTS = config.onCancelTTS || (() => {});
    this.onStartListening = config.onStartListening || (() => {});
    this.onStopListening = config.onStopListening || (() => {});
    this.onProcessUserSpeech = config.onProcessUserSpeech || (() => {});
    this.onEndConversation = config.onEndConversation || (() => {});
    this.onError = config.onError || (() => {});

    // --- State ---
    this.state = STATE.IDLE;
    this.started = false;
    this.ended = false;

    // --- Barge-in tracking ---
    /** Set when barge-in arrives during PROCESSING; causes llmResponse to skip TTS. */
    this.bargeInPending = false;

    // --- Endpointing tracking ---
    this.lastPartialTranscript = '';
    this.speechStarted = false;
    /**
     * Final transcripts for the CURRENT utterance, in order.
     *
     * STT emits a final at every pause, not at every end of turn — someone
     * saying "हाँ … मैंने दवाई ले ली" produces two. Endpointing on the first
     * one answered half a sentence and talked over the rest, which is what a
     * caller experiences as "it is not listening to me".
     */
    this.finalTranscripts = [];
    /** True once the browser's VAD has reported silence for this utterance. */
    this.silenceSignalled = false;

    // --- Silence timeout tracking ---
    /** Consecutive silence timeouts; 1 = retry prompt, 2 = end conversation. */
    this.consecutiveSilenceTimeouts = 0;

    // --- Pending outcome ---
    /** Outcome to emit after farewell TTS finishes (set when LLM returns report_outcome + text). */
    this.pendingOutcome = null;

    // --- Timers ---
    this._silenceTimer = null;
    this._endpointTimer = null;
    this._maxSpeechTimer = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start the conversation. The agent speaks the first message, then listens.
   *
   * @param {string} firstMessage - Text for the agent to speak first
   */
  start(firstMessage) {
    if (this.ended) {
      this._warn('start', 'conversation already ended');
      return;
    }
    if (this.started) {
      this._warn('start', 'conversation already started');
      return;
    }
    this.started = true;

    if (firstMessage && String(firstMessage).trim()) {
      this._transition(STATE.SPEAKING);
      this.onAgentSpeak(String(firstMessage).trim());
    } else {
      // No first message — skip speaking, go straight to listening.
      this._enterListening();
    }
  }

  /**
   * Notify that TTS audio has finished playing in the browser.
   *
   * If the agent was speaking a farewell message before an outcome,
   * the conversation ends here. Otherwise, transitions to LISTENING.
   */
  ttsFinished() {
    if (this.ended) {
      this._warn('ttsFinished', 'conversation ended');
      return;
    }
    if (this.state !== STATE.SPEAKING) {
      this._warn('ttsFinished', `unexpected state: ${this.state}`);
      return;
    }

    // If a farewell was spoken before an outcome, end now.
    if (this.pendingOutcome) {
      const outcome = this.pendingOutcome;
      this.pendingOutcome = null;
      this._end(outcome);
      return;
    }

    // Normal: agent finished speaking, start listening.
    this._enterListening();
  }

  /**
   * User interrupted — barge-in during agent speech or LLM processing.
   *
   * During SPEAKING: cancels TTS and transitions to LISTENING.
   * During PROCESSING: marks barge-in pending so the LLM response skips TTS.
   */
  bargeIn() {
    if (this.ended) {
      this._warn('bargeIn', 'conversation ended');
      return;
    }

    if (this.state === STATE.SPEAKING) {
      this.onCancelTTS();
      this.pendingOutcome = null; // user interrupted before farewell finished
      this._enterListening();
    } else if (this.state === STATE.PROCESSING) {
      this.bargeInPending = true;
      logger.log('turn_bargein_pending', { state: this.state });
    } else {
      this._warn('bargeIn', `unexpected state: ${this.state}`);
    }
  }

  /**
   * STT transcript received from the browser.
   *
   * Final transcripts trigger endpointing (transition to PROCESSING).
   * Partial transcripts update the running buffer and start speech tracking.
   *
   * @param {string} text - Transcript text
   * @param {boolean} isFinal - Whether this is a final (complete) transcript
   */
  userTranscript(text, isFinal) {
    if (this.ended) {
      this._warn('userTranscript', 'conversation ended');
      return;
    }
    if (this.state !== STATE.LISTENING) {
      this._warn('userTranscript', `unexpected state: ${this.state}`);
      return;
    }

    if (isFinal) {
      if (text && String(text).trim()) {
        this.finalTranscripts.push(String(text).trim());
        this.lastPartialTranscript = '';
        if (!this.speechStarted) this._onSpeechStarted();

        // The browser's VAD has already said this utterance is over, so this
        // final is the last piece of it: answer now, exactly as before.
        // Otherwise hold it and let the endpoint timer (or that silence
        // signal, when it comes) decide — the person may still be talking.
        if (this.silenceSignalled) {
          this._endpoint();
        } else {
          this._startEndpointTimer();
        }
      }
      // Empty final transcript — ignore (STT detected end-of-speech with no words).
    } else {
      // Partial — update buffer and ensure speech tracking is active.
      this.lastPartialTranscript = text || '';
      if (!this.speechStarted) {
        this._onSpeechStarted();
      }
      // New partial arriving — reset the endpoint silence timer.
      this._clearEndpointTimer();
    }
  }

  /**
   * LLM response received.
   *
   * If the response contains a `report_outcome` tool call, the conversation
   * ends with that outcome (speaking any farewell text first).
   * If barge-in is pending, TTS is skipped and we go straight to LISTENING.
   * Otherwise, the agent speaks the response text.
   *
   * @param {string|null} text - Response text (may be empty/null)
   * @param {Array<Object>} [toolCalls] - Tool calls from the LLM
   */
  llmResponse(text, toolCalls, options = {}) {
    // `alreadySpoken` is the streaming pipeline telling us it has synthesized
    // this reply already, sentence by sentence, as the tokens arrived. Without
    // it every reply went out twice: once streamed, once whole. The state
    // machine is unchanged either way — SPEAKING is still entered and left
    // through ttsFinished, so pendingOutcome and the return to LISTENING have
    // exactly one path out.
    const alreadySpoken = options.alreadySpoken === true;
    if (this.ended) {
      this._warn('llmResponse', 'conversation ended');
      return;
    }
    if (this.state !== STATE.PROCESSING) {
      this._warn('llmResponse', `unexpected state: ${this.state}`);
      return;
    }

    // 1. Check for report_outcome tool call.
    const outcome = this._extractOutcome(toolCalls);
    if (outcome) {
      if (text && String(text).trim() && !this.bargeInPending) {
        // Speak farewell text, then end after TTS finishes.
        this.pendingOutcome = outcome;
        this._transition(STATE.SPEAKING);
        this._speakOrFinish(String(text).trim(), alreadySpoken);
      } else {
        // No farewell (or barge-in pending) — end immediately.
        this.bargeInPending = false;
        this._end(outcome);
      }
      return;
    }

    // 2. Check for barge-in pending — skip TTS, go straight to listening.
    if (this.bargeInPending) {
      this.bargeInPending = false;
      logger.log('turn_bargein_skip_tts');
      this._enterListening();
      return;
    }

    // 3. Normal response — speak the text.
    if (text && String(text).trim()) {
      this._transition(STATE.SPEAKING);
      this._speakOrFinish(String(text).trim(), alreadySpoken);
    } else {
      // No text and no outcome — resume listening.
      this._warn('llmResponse', 'no text and no outcome, resuming listening');
      this._enterListening();
    }
  }

  /**
   * Browser VAD detected user speech.
   *
   * Clears the silence timeout and starts the max-speech-duration timer.
   * Only meaningful during LISTENING.
   */
  speechDetected() {
    if (this.ended) {
      this._warn('speechDetected', 'conversation ended');
      return;
    }
    if (this.state !== STATE.LISTENING) {
      this._warn('speechDetected', `unexpected state: ${this.state}`);
      return;
    }
    if (!this.speechStarted) {
      this._onSpeechStarted();
    }
  }

  /**
   * Browser VAD detected silence.
   *
   * If speech had started, starts the endpoint silence timer — when it fires
   * without a final transcript, the last partial transcript is used as the endpoint.
   * Only meaningful during LISTENING.
   */
  silenceDetected() {
    if (this.ended) {
      this._warn('silenceDetected', 'conversation ended');
      return;
    }
    if (this.state !== STATE.LISTENING) {
      this._warn('silenceDetected', `unexpected state: ${this.state}`);
      return;
    }
    this.silenceSignalled = true;

    // A final is already waiting: the VAD saying "they have stopped" is the
    // signal it was waiting for. Answer now rather than sitting out the
    // endpoint timer on top of the silence the VAD already measured.
    if (this.finalTranscripts.length > 0) {
      this._endpoint();
      return;
    }

    if (this.speechStarted && !this._endpointTimer) {
      this._startEndpointTimer();
    }
    // If speech hasn't started, the silence timer is already running.
  }

  /**
   * Stop the conversation and clean up all timers.
   *
   * Can be called from any state. After stop(), all other methods are no-ops.
   *
   * Returns whatever onEndConversation returns (a Promise, if the caller's
   * callback is async) so a caller that needs to know the session is fully
   * closed before proceeding — see PlaygroundConversation.stop() — can await
   * it. Idempotent stop() (this.ended already true) resolves immediately.
   *
   * @returns {*|undefined}
   */
  stop(opts = {}) {
    if (this.ended) {
      return; // Already ended — idempotent.
    }
    // `source` distinguishes a deliberate end from an interrupted one. A
    // person clicking Stop, or hanging up, has finished the call; a socket
    // closing has not. Downstream that is the difference between a session
    // that is completed and one that stays resumable.
    return this._end({
      label: 'STOPPED',
      source: opts.source || 'manual',
      reason: opts.reason || 'stop_called',
    });
  }

  /**
   * Get the current state.
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called when speech is first detected (via VAD or partial transcript).
   * Clears the silence timer and starts the max-speech-duration timer.
   * @private
   */
  _onSpeechStarted() {
    // A new burst of speech: whatever silence the VAD reported before it is
    // no longer the end of anything.
    this.silenceSignalled = false;
    this.speechStarted = true;
    this._clearSilenceTimer();
    this._startMaxSpeechTimer();
  }

  /**
   * Enter LISTENING state: reset tracking, start silence timer, notify callback.
   * @private
   */
  /**
   * Speak this text, or — when the caller has already spoken it — go straight
   * to the end-of-speech transition.
   *
   * @param {string} text
   * @param {boolean} alreadySpoken
   * @private
   */
  _speakOrFinish(text, alreadySpoken) {
    if (!alreadySpoken) {
      this.onAgentSpeak(text);
      return;
    }
    this.ttsFinished();
  }

  _enterListening() {
    this._clearTimers();
    this.speechStarted = false;
    this.lastPartialTranscript = '';
    this.finalTranscripts = [];
    this.silenceSignalled = false;
    this._transition(STATE.LISTENING);
    this._startSilenceTimer();
    this.onStartListening();
  }

  /**
   * Endpoint: user speech is complete — stop listening and send to LLM.
   *
   * The utterance is every final STT produced for it, joined in order, with
   * any trailing partial that never got a final of its own. Passing one
   * transcript in was what made a pause mid-sentence cost the second half.
   *
   * @param {string} [fallback] - Used when nothing was captured (max-speech force)
   * @private
   */
  _endpoint(fallback) {
    const parts = this.finalTranscripts.slice();
    const trailing = (this.lastPartialTranscript || '').trim();
    if (trailing) parts.push(trailing);

    const transcript = parts.join(' ').trim() || (fallback || '').trim();

    this._clearTimers();
    this.consecutiveSilenceTimeouts = 0;
    this.finalTranscripts = [];
    this.lastPartialTranscript = '';
    this.silenceSignalled = false;
    this.onStopListening();
    this._transition(STATE.PROCESSING);
    this.onProcessUserSpeech(transcript);
  }

  /**
   * End the conversation: clean up timers, cancel any active modality,
   * transition to IDLE, and notify the caller.
   * @param {Object} [outcome] - Conversation outcome
   * @returns {*|undefined} Whatever onEndConversation returns, propagated so stop() can await it
   * @private
   */
  _end(outcome) {
    this.ended = true;
    this.bargeInPending = false;
    this._clearTimers();

    if (this.state === STATE.LISTENING) {
      this.onStopListening();
    } else if (this.state === STATE.SPEAKING) {
      this.onCancelTTS();
    }

    this._transition(STATE.IDLE);
    return this.onEndConversation(outcome);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Timer management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start the silence timer. On first fire → retry prompt. On second → end.
   * @private
   */
  _startSilenceTimer() {
    this._clearSilenceTimer();
    this._silenceTimer = setTimeout(() => {
      this._silenceTimer = null;
      if (this.ended || this.state !== STATE.LISTENING) return;

      this.consecutiveSilenceTimeouts++;

      if (this.consecutiveSilenceTimeouts === 1) {
        // First timeout — agent says retry prompt.
        logger.log('turn_silence_retry', { count: this.consecutiveSilenceTimeouts });
        this._clearTimers();
        this.onStopListening();
        this._transition(STATE.SPEAKING);
        this.onAgentSpeak(this.retryPromptText);
      } else {
        // Second consecutive timeout — end conversation.
        logger.log('turn_silence_timeout', { count: this.consecutiveSilenceTimeouts });
        this._end({
          label: 'NO_ANSWER',
          source: 'watchdog',
          reason: 'max_silence_exceeded',
        });
      }
    }, this.silenceTimeoutMs);
  }

  /**
   * Start the endpoint silence timer. On fire, endpoint with last partial
   * transcript (or reset if it was a false alarm).
   * @private
   */
  _startEndpointTimer() {
    this._clearEndpointTimer();
    this._endpointTimer = setTimeout(() => {
      this._endpointTimer = null;
      if (this.ended || this.state !== STATE.LISTENING) return;

      const pending =
        this.finalTranscripts.length > 0 ||
        Boolean(this.lastPartialTranscript && this.lastPartialTranscript.trim());

      if (pending) {
        logger.log('turn_endpoint_silence', {
          transcript: [...this.finalTranscripts, this.lastPartialTranscript].join(' ').trim(),
        });
        this._endpoint();
      } else {
        // False alarm — VAD detected speech but STT produced nothing.
        this.speechStarted = false;
        this._clearMaxSpeechTimer();
        this._startSilenceTimer();
      }
    }, this.endpointSilenceMs);
  }

  /**
   * Start the max-speech-duration timer. On fire, force endpoint with last partial.
   * @private
   */
  _startMaxSpeechTimer() {
    this._clearMaxSpeechTimer();
    this._maxSpeechTimer = setTimeout(() => {
      this._maxSpeechTimer = null;
      if (this.ended || this.state !== STATE.LISTENING) return;

      logger.log('turn_max_speech', {
        transcript: [...this.finalTranscripts, this.lastPartialTranscript].join(' ').trim(),
      });
      // Force endpoint even with nothing captured — let the LLM handle it.
      this._endpoint('');
    }, this.maxSpeechDurationMs);
  }

  /** @private Clear the silence timer. */
  _clearSilenceTimer() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
  }

  /** @private Clear the endpoint silence timer. */
  _clearEndpointTimer() {
    if (this._endpointTimer) {
      clearTimeout(this._endpointTimer);
      this._endpointTimer = null;
    }
  }

  /** @private Clear the max-speech-duration timer. */
  _clearMaxSpeechTimer() {
    if (this._maxSpeechTimer) {
      clearTimeout(this._maxSpeechTimer);
      this._maxSpeechTimer = null;
    }
  }

  /** @private Clear all timers. */
  _clearTimers() {
    this._clearSilenceTimer();
    this._clearEndpointTimer();
    this._clearMaxSpeechTimer();
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transition to a new state and notify via callback.
   * @param {string} newState - Target state
   * @private
   */
  _transition(newState) {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;
    this.onStateChange(oldState, newState);
    logger.log('turn_state_change', { from: oldState, to: newState });
  }

  /**
   * Log a warning for an unexpected method call.
   * @param {string} method - Method name
   * @param {string} reason - Why it was unexpected
   * @private
   */
  _warn(method, reason) {
    logger.log('turn_warn', { method, reason, state: this.state });
  }

  /**
   * Extract an outcome from LLM tool calls if `report_outcome` is present.
   *
   * @param {Array<Object>} [toolCalls] - Tool calls from the LLM response
   * @returns {Object|null} Outcome object, or null if no report_outcome found
   * @private
   */
  _extractOutcome(toolCalls) {
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      return null;
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name || toolCall.name;
      if (toolName !== 'report_outcome') continue;

      let args = toolCall.function?.arguments || toolCall.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (!args || typeof args !== 'object') args = {};

      return {
        label: args.outcome || 'UNKNOWN',
        source: 'tool_call',
        reason: args.reason || 'llm_reported',
      };
    }

    return null;
  }
}

module.exports = { TurnManager, STATE };
