'use strict';

/**
 * Playground Conversation
 *
 * Manages a single browser-based voice conversation. Uses the TurnManager
 * for proper turn-taking with barge-in, endpointing, and silence handling.
 *
 * Flow:
 *   1. start() — Agent speaks first message (TTS)
 *   2. processAudio() — Browser sends VAD-gated audio, STT transcribes
 *   3. TurnManager handles endpointing → triggers LLM
 *   4. LLM response → TTS synthesizes → sent to browser
 *   5. If LLM calls report_outcome → conversation ends with outcome
 *   6. Barge-in: if user speaks during TTS, cancel TTS and listen
 *
 * The system prompt and first message come from the same config files
 * as phone calls, so prompt changes in the playground also apply to phone calls.
 *
 * Session lifecycle (opening a call, capturing fields, closing a call) is
 * routed through PlaygroundTransportAdapter, which drives the same
 * src/core/call/lifecycle.js module the phone path uses — see that
 * adapter's docstring. This is what makes an inbound simulated call for a
 * patient with a dropped session resume here exactly as it would on a
 * phone call.
 */

const logger = require('../utils/logger');
const { TurnLatency } = require('../utils/latency');
const { TurnManager, STATE } = require('./turn-manager');
const { SentenceBuffer } = require('../utils/sentence-buffer');
const { buildInboundVariables } = require('../use-cases/medication-adherence/inbound-context');

class PlaygroundConversation {
  /**
   * @param {Object} deps
   * @param {Object} deps.providerRegistry - For getting STT/TTS/LLM adapters
   * @param {Object} deps.strategy - Active ConversationStrategy
   * @param {Object} deps.transport - PlaygroundTransportAdapter instance (session lifecycle)
   * @param {string} deps.language - 'hi' or 'en'
   * @param {string|null} deps.phone - Selected patient's E.164 phone
   * @param {'inbound'|'outbound'} deps.direction
   * @param {Function} deps.onTranscript - (text, isFinal) => void
   * @param {Function} deps.onAgentResponse - (text) => void
   * @param {Function} deps.onAudio - (pcmBuffer) => void
   * @param {Function} deps.onOutcome - (outcome) => void
   * @param {Function} deps.onStateChange - (oldState, newState) => void
   * @param {Function} deps.onModeResolved - (mode) => void — mode returned by openSession
   * @param {Function} deps.onError - (err) => void
   */
  constructor(deps) {
    this.providerRegistry = deps.providerRegistry;
    this.strategy = deps.strategy;
    this.transport = deps.transport;
    this.language = deps.language || 'hi';
    this.phone = deps.phone || null;
    this.direction = deps.direction === 'outbound' ? 'outbound' : 'inbound';

    // Callbacks
    this.onTranscript = deps.onTranscript || (() => {});
    this.onAgentResponse = deps.onAgentResponse || (() => {});
    this.onAudio = deps.onAudio || (() => {});
    this.onOutcome = deps.onOutcome || (() => {});
    this.onStateChange = deps.onStateChange || (() => {});
    this.onModeResolved = deps.onModeResolved || (() => {});
    this.onError = deps.onError || (() => {});

    // Conversation state
    this.messages = [];
    this.sttAdapter = null;
    this.ended = false;
    /** This session's id, minted by transport.openSession(); null until start() resolves. */
    this.sessionId = null;
    /** Resolved mode ('outbound' | 'inbound' | 'resume'); null until start() resolves. */
    this.mode = null;

    // Build language-specific strategy for prompt generation
    const StrategyClass = this.strategy.constructor;
    this.langStrategy = new StrategyClass(this.language);

    // Create turn manager
    this.turn = new TurnManager({
      silenceTimeoutMs: (this.langStrategy.getConfig().silenceTimeoutSeconds || 15) * 1000,
      endpointSilenceMs: 1500,
      maxSpeechDurationMs: 30000,
      retryPromptText: this.language === 'en'
        ? 'Are you there?'
        : 'क्या आप वहाँ हैं?',
      maxRetries: 1,

      onStateChange: (oldState, newState) => {
        this.onStateChange(oldState, newState);
      },
      onAgentSpeak: (text) => {
        this._speak(text);
      },
      onCancelTTS: () => {
        // Cancel streaming TTS: set flag and disconnect WebSocket to stop generation
        this._cancelTTS = true;
        const ttsAdapter = this.providerRegistry.getActivePlaygroundTTS();
        if (ttsAdapter && ttsAdapter.isStreamConnected) {
          ttsAdapter.disconnectStream().catch(() => {});
        }
      },
      onStartListening: () => {
        this._startListening();
      },
      onStopListening: () => {
        this._stopListening();
      },
      onProcessUserSpeech: (transcript) => {
        this._processUserSpeech(transcript);
      },
      onEndConversation: (outcome) => {
        // A real report_outcome tool call ends the session as completed;
        // anything else (manual stop, silence timeout, a browser disconnect
        // routed through stop()) closes it as dropped, so the next
        // playground session for this patient resumes — the same rule
        // terminalStatusFor applies on the phone path.
        const endedReason = outcome && outcome.source === 'tool_call' ? 'customer-ended-call' : undefined;
        this._closeSession(endedReason);
        this.onOutcome(outcome);
      },
      onError: (err) => {
        this.onError(err);
      },
    });
  }

  /**
   * Start the conversation. Resolves the patient/mode exactly like the
   * phone path's assistant-request handler, then the agent speaks the
   * first message.
   */
  async start() {
    try {
      // 1. Open the session — resolves caller to patient/mode, opens (or
      // resumes into) a session, exactly as the Vapi adapter does for a
      // phone call. Must happen before anything else: the system prompt and
      // first message both depend on the resolved mode and variables.
      const resolution = await this.transport.openSession({ phone: this.phone, direction: this.direction });
      this.sessionId = resolution.sessionId;
      this.mode = resolution.mode;
      this.onModeResolved(this.mode);

      // 2. Initialize STT adapter
      this.sttAdapter = this.providerRegistry.getActiveSTT();
      const sttConfig = this.providerRegistry.getSTTConfig();

      // Override language if English
      if (this.language === 'en') {
        sttConfig.language = 'en-IN';
      }

      await this.sttAdapter.init(sttConfig, process.env);

      // 3. Build system prompt and first message from the resolved mode and
      // variables — exactly as the Vapi adapter's buildAssistantConfig does.
      const variables = buildInboundVariables(resolution, this.language);
      const systemPrompt = this.langStrategy.buildSystemPrompt(variables, this.mode);
      const firstMessage = this.langStrategy.buildFirstMessage(variables, this.mode);

      // 4. Initialize conversation history
      this.messages = [
        { role: 'system', content: systemPrompt },
      ];

      // 5. Start turn manager — agent speaks first
      this.turn.start(firstMessage);
    } catch (err) {
      logger.error('playground_start_error', err);
      this.onError(err);
    }
  }

  /**
   * Process audio chunk from the browser (VAD-gated, only during speech).
   * @param {Buffer} audioChunk - Raw 16-bit PCM, 16kHz, mono
   */
  async processAudio(audioChunk) {
    if (this.ended) return;
    if (this.turn.getState() !== STATE.LISTENING) return;

    try {
      await this.sttAdapter.transcribe(audioChunk, (transcript, isFinal) => {
        this.onTranscript(transcript, isFinal);

        if (isFinal && transcript.trim()) {
          // Final transcript — turn manager handles endpointing
          this.turn.userTranscript(transcript, true);
        } else if (transcript.trim()) {
          // Partial transcript — update turn manager for endpointing
          this.turn.userTranscript(transcript, false);
        }
      });
    } catch (err) {
      logger.error('playground_audio_error', err);
      this.onError(err);
    }
  }

  /**
   * Handle barge-in from the browser (user speaking during agent TTS).
   */
  bargeIn() {
    if (this.ended) return;
    this.turn.bargeIn();
  }

  /**
   * VAD detected speech — reset silence timer.
   */
  speechDetected() {
    if (this.ended) return;
    this.turn.speechDetected();
  }

  /**
   * VAD detected silence after speech — trigger endpoint check.
   */
  silenceDetected() {
    if (this.ended) return;
    this.turn.silenceDetected();
  }

  // ── Internal methods ─────────────────────────────────────────────

  /**
   * Start listening for user speech.
   * @private
   */
  _startListening() {
    // STT adapter is already initialized — it will accept audio via processAudio()
    // The turn manager controls whether processAudio() forwards to STT
  }

  /**
   * Stop listening.
   * @private
   */
  _stopListening() {
    // Nothing to do — the turn manager state prevents processAudio() from forwarding
  }

  /**
   * Process user speech — stream LLM response, pipeline through TTS.
   *
   * Instead of waiting for the full LLM response then synthesizing all at once,
   * this streams LLM tokens, buffers them into sentences, and sends each
   * sentence to the TTS WebSocket as soon as it's ready. Audio chunks flow
   * back to the browser in real time.
   *
   * @param {string} transcript
   * @private
   */
  async _processUserSpeech(transcript) {
    if (this.ended) return;

    // Turn clock starts the instant the caller stopped speaking (PILOT-PLAN §6.3).
    this._turnIndex = (this._turnIndex || 0) + 1;
    const latency = new TurnLatency({ callId: this.sessionId, turnIndex: this._turnIndex });

    // Add user message to history
    this.messages.push({ role: 'user', content: transcript });
    await this._recordTurn({ role: 'user', content: transcript });

    try {
      const llmAdapter = this.providerRegistry.getActiveLLM();
      const llmConfig = this.providerRegistry.getLLMConfig();

      const requestBody = {
        messages: this.messages,
        tools: this.langStrategy.getTools(),
        tool_choice: 'auto',
      };

      // --- Streaming pipeline ---
      // 1. Connect TTS (streaming adapters only — see _synthesizeSentence)
      const ttsAdapter = this.providerRegistry.getActivePlaygroundTTS();
      const ttsConfig = this.providerRegistry.getTTSConfig();
      const ttsOverrides = this._ttsOverrides();

      if (_isStreamingTTS(ttsAdapter) && !ttsAdapter.isStreamConnected()) {
        await ttsAdapter.connectStream(ttsConfig, process.env, ttsOverrides);
      }

      // 2. Set up sentence buffer — each complete sentence goes to TTS
      const sentenceBuffer = new SentenceBuffer();
      let ttsError = null;

      sentenceBuffer.onSentence(async (sentence) => {
        if (this.ended || this._cancelTTS) return;
        try {
          await this._synthesizeSentence(ttsAdapter, ttsConfig, ttsOverrides, sentence, (pcmChunk) => {
            if (!this._cancelTTS) {
              latency.ttsFirstAudio();
              this.onAudio(pcmChunk);
            }
          });
        } catch (err) {
          ttsError = err;
          logger.error('stream_tts_sentence_error', err, {
            sentence: sentence.substring(0, 50),
          });
        }
      });

      // 3. Stream LLM tokens → sentence buffer → TTS → audio chunks
      const { content, tool_calls } = await llmAdapter.chatCompletionStream(
        requestBody,
        llmConfig,
        process.env,
        (token) => {
          latency.llmFirstToken();
          // Each token delta goes into the sentence buffer
          sentenceBuffer.push(token);
        }
      );

      // 4. Flush any remaining text in the buffer
      sentenceBuffer.flush();

      // 5. Build assistant message for history
      const assistantMessage = {
        role: 'assistant',
        content: content,
        tool_calls: tool_calls,
      };
      this.messages.push(assistantMessage);
      await this._recordTurn({ role: 'assistant', content, toolCalls: tool_calls });

      // 5b. Route capture_field tool calls through the shared lifecycle
      // module — same as the phone path, this is what makes fields_so_far
      // non-empty before the session ends. report_outcome is handled by the
      // turn manager below, via llmResponse's own tool-call extraction.
      await this._handleCaptureFieldCalls(tool_calls);

      // 6. Notify turn manager
      latency.turnComplete();
      this.turn.llmResponse(content, tool_calls);
    } catch (err) {
      latency.turnComplete();
      logger.error('playground_stream_llm_error', err);
      this.onError(err);
      this.turn.llmResponse(null, null);
    }
  }

  /**
   * Speak text via streaming TTS (used for first message and retry prompts).
   *
   * Connects to the TTS WebSocket, sends the full text, and streams audio
   * chunks to the browser as they arrive.
   *
   * @param {string} text
   * @private
   */
  async _speak(text) {
    this._cancelTTS = false;

    try {
      this.onAgentResponse(text);

      const ttsAdapter = this.providerRegistry.getActivePlaygroundTTS();
      const ttsConfig = this.providerRegistry.getTTSConfig();
      const ttsOverrides = this._ttsOverrides();

      // Connect TTS WebSocket if needed (streaming adapters only)
      if (_isStreamingTTS(ttsAdapter) && !ttsAdapter.isStreamConnected()) {
        await ttsAdapter.connectStream(ttsConfig, process.env, ttsOverrides);
      }

      // Send text and stream (or, for a blocking adapter, play back) audio
      await this._synthesizeSentence(ttsAdapter, ttsConfig, ttsOverrides, text, (pcmChunk) => {
        if (!this._cancelTTS) {
          this.onAudio(pcmChunk);
        }
      });

      // Check if TTS was cancelled (barge-in)
      if (this._cancelTTS) {
        logger.log('playground_tts_cancelled', { text: text.substring(0, 40) });
        if (_isStreamingTTS(ttsAdapter)) await ttsAdapter.disconnectStream();
        return;
      }

      // Notify turn manager that TTS is finished
      this.turn.ttsFinished();
    } catch (err) {
      logger.error('playground_tts_stream_error', err);
      this.onError(err);
      this.turn.ttsFinished();
    }
  }

  /**
   * Route any `capture_field` tool calls in an LLM response through the
   * shared lifecycle module. report_outcome is left alone here — the turn
   * manager extracts and acts on that one itself.
   *
   * @param {Array<Object>} [toolCalls]
   * @private
   */
  async _handleCaptureFieldCalls(toolCalls) {
    if (!this.sessionId || !Array.isArray(toolCalls)) return;

    for (const call of toolCalls) {
      const name = call.function?.name || call.name;
      if (name !== 'capture_field') continue;

      let args = call.function?.arguments || call.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (!args || typeof args !== 'object') continue;

      try {
        await this.transport.captureField({ sessionId: this.sessionId, field: args.field, value: args.value });
      } catch (err) {
        logger.error('playground_capture_field_error', err);
      }
    }
  }

  /**
   * Persist one turn of history through the transport, mirroring the phone
   * path's write. Tolerates never having opened a session (this.sessionId
   * null) — the transport's recordTurn already logs and drops that case.
   *
   * @param {Object} args - { role, content, toolCalls }
   * @private
   */
  async _recordTurn({ role, content, toolCalls }) {
    try {
      await this.transport.recordTurn({ sessionId: this.sessionId, role, content, toolCalls });
    } catch (err) {
      logger.error('playground_record_turn_error', err);
    }
  }

  /**
   * Close this session into its terminal status. Tolerates never having
   * opened one (e.g. start() failed before openSession resolved).
   *
   * @param {string} [endedReason] - See closeSession's doc comment
   * @private
   */
  async _closeSession(endedReason) {
    if (!this.sessionId) return;
    try {
      await this.transport.closeSession({ sessionId: this.sessionId, endedReason });
    } catch (err) {
      logger.error('playground_close_session_error', err);
    }
  }

  /**
   * Language-driven TTS overrides shared by _speak and _processUserSpeech.
   * @private
   */
  _ttsOverrides() {
    const overrides = { output_audio_codec: 'linear16' };
    if (this.language === 'en') {
      overrides.target_language_code = 'en-IN';
    }
    return overrides;
  }

  /**
   * Synthesize one piece of text to audio, using whichever API the active
   * TTS adapter actually implements.
   *
   * Sarvam implements the low-latency streaming WebSocket API
   * (connectStream/sendText/isStreamConnected) this method prefers. A
   * TTSPort-only adapter (e.g. ElevenLabsTTSAdapter, bridged for the
   * playground per Task 2) implements just the blocking `synthesize()` —
   * for those, onChunk is called once with the whole utterance's audio
   * rather than progressively, which is a real latency trade-off, not a
   * streaming implementation this codebase has verified for that vendor.
   *
   * @param {Object} ttsAdapter
   * @param {Object} ttsConfig
   * @param {Object} ttsOverrides
   * @param {string} text
   * @param {Function} onChunk - (pcmBuffer) => void
   * @private
   */
  async _synthesizeSentence(ttsAdapter, ttsConfig, ttsOverrides, text, onChunk) {
    if (_isStreamingTTS(ttsAdapter)) {
      await ttsAdapter.sendText(text, onChunk);
      return;
    }
    const pcm = await ttsAdapter.synthesize({ text, sampleRate: 16000, ...ttsOverrides }, ttsConfig, process.env);
    onChunk(pcm);
  }

  /**
   * Stop the conversation externally (browser disconnect or user stop).
   */
  async stop() {
    this.ended = true;
    // turn.stop() triggers onEndConversation with a non-tool_call outcome,
    // which _closeSession maps to 'dropped' — this is what makes a browser
    // disconnect (ws-handler calls stop() on 'close') or an explicit Stop
    // click resumable on the next playground session.
    this.turn.stop();

    // Disconnect TTS streaming WebSocket, if this adapter has one
    const ttsAdapter = this.providerRegistry.getActivePlaygroundTTS();
    if (_isStreamingTTS(ttsAdapter)) {
      try { await ttsAdapter.disconnectStream(); } catch (e) { /* ignore */ }
    }

    if (this.sttAdapter) {
      try { await this.sttAdapter.dispose(); } catch (e) { /* ignore */ }
      this.sttAdapter = null;
    }
  }
}

/**
 * Whether a TTS adapter implements the streaming WebSocket API
 * (Sarvam), as opposed to only TTSPort's blocking `synthesize()`
 * (e.g. the ElevenLabs bridge — see _synthesizeSentence).
 * @private
 */
function _isStreamingTTS(ttsAdapter) {
  return !!(ttsAdapter && typeof ttsAdapter.isStreamConnected === 'function');
}

module.exports = { PlaygroundConversation, STATE };
