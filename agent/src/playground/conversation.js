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
 */

const logger = require('../utils/logger');
const { TurnLatency } = require('../utils/latency');
const { TurnManager, STATE } = require('./turn-manager');
const { SentenceBuffer } = require('../utils/sentence-buffer');

class PlaygroundConversation {
  /**
   * @param {Object} deps
   * @param {Object} deps.providerRegistry - For getting STT/TTS/LLM adapters
   * @param {Object} deps.strategy - Active ConversationStrategy
   * @param {string} deps.language - 'hi' or 'en'
   * @param {Object} deps.variables - Per-call variables (parent_name, drug_name)
   * @param {Function} deps.onTranscript - (text, isFinal) => void
   * @param {Function} deps.onAgentResponse - (text) => void
   * @param {Function} deps.onAudio - (pcmBuffer) => void
   * @param {Function} deps.onOutcome - (outcome) => void
   * @param {Function} deps.onStateChange - (oldState, newState) => void
   * @param {Function} deps.onError - (err) => void
   */
  constructor(deps) {
    this.providerRegistry = deps.providerRegistry;
    this.strategy = deps.strategy;
    this.language = deps.language || 'hi';
    this.variables = deps.variables || {};

    // Callbacks
    this.onTranscript = deps.onTranscript || (() => {});
    this.onAgentResponse = deps.onAgentResponse || (() => {});
    this.onAudio = deps.onAudio || (() => {});
    this.onOutcome = deps.onOutcome || (() => {});
    this.onStateChange = deps.onStateChange || (() => {});
    this.onError = deps.onError || (() => {});

    // Conversation state
    this.messages = [];
    this.sttAdapter = null;
    this.ended = false;

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
        const ttsAdapter = this.providerRegistry.getActiveTTS();
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
        this.onOutcome(outcome);
      },
      onError: (err) => {
        this.onError(err);
      },
    });
  }

  /**
   * Start the conversation. Agent speaks the first message.
   */
  async start() {
    try {
      // 1. Initialize STT adapter
      this.sttAdapter = this.providerRegistry.getActiveSTT();
      const sttConfig = this.providerRegistry.getSTTConfig();

      // Override language if English
      if (this.language === 'en') {
        sttConfig.language = 'en-IN';
      }

      await this.sttAdapter.init(sttConfig, process.env);

      // 2. Build system prompt and first message
      const systemPrompt = this.langStrategy.buildSystemPrompt(this.variables);
      const firstMessage = this.langStrategy.buildFirstMessage(this.variables);

      // 3. Initialize conversation history
      this.messages = [
        { role: 'system', content: systemPrompt },
      ];

      // 4. Start turn manager — agent speaks first
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
    const latency = new TurnLatency({ callId: this.callId, turnIndex: this._turnIndex });

    // Add user message to history
    this.messages.push({ role: 'user', content: transcript });

    try {
      const llmAdapter = this.providerRegistry.getActiveLLM();
      const llmConfig = this.providerRegistry.getLLMConfig();

      const requestBody = {
        messages: this.messages,
        tools: this.langStrategy.getTools(),
        tool_choice: 'auto',
      };

      // --- Streaming pipeline ---
      // 1. Connect TTS WebSocket (if not already connected)
      const ttsAdapter = this.providerRegistry.getActiveTTS();
      const ttsConfig = this.providerRegistry.getTTSConfig();

      const ttsOverrides = {};
      if (this.language === 'en') {
        ttsOverrides.target_language_code = 'en-IN';
      }
      ttsOverrides.output_audio_codec = 'linear16';

      if (!ttsAdapter.isStreamConnected()) {
        await ttsAdapter.connectStream(ttsConfig, process.env, ttsOverrides);
      }

      // 2. Set up sentence buffer — each complete sentence goes to TTS
      const sentenceBuffer = new SentenceBuffer();
      let ttsError = null;

      sentenceBuffer.onSentence(async (sentence) => {
        if (this.ended || this._cancelTTS) return;
        try {
          await ttsAdapter.sendText(sentence, (pcmChunk) => {
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

      const ttsAdapter = this.providerRegistry.getActiveTTS();
      const ttsConfig = this.providerRegistry.getTTSConfig();

      const ttsOverrides = {};
      if (this.language === 'en') {
        ttsOverrides.target_language_code = 'en-IN';
      }
      ttsOverrides.output_audio_codec = 'linear16';

      // Connect TTS WebSocket if needed
      if (!ttsAdapter.isStreamConnected()) {
        await ttsAdapter.connectStream(ttsConfig, process.env, ttsOverrides);
      }

      // Send text and stream audio chunks
      await ttsAdapter.sendText(text, (pcmChunk) => {
        if (!this._cancelTTS) {
          this.onAudio(pcmChunk);
        }
      });

      // Check if TTS was cancelled (barge-in)
      if (this._cancelTTS) {
        logger.log('playground_tts_cancelled', { text: text.substring(0, 40) });
        await ttsAdapter.disconnectStream();
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
   * Stop the conversation externally (browser disconnect or user stop).
   */
  async stop() {
    this.ended = true;
    this.turn.stop();

    // Disconnect TTS streaming WebSocket
    const ttsAdapter = this.providerRegistry.getActiveTTS();
    if (ttsAdapter && ttsAdapter.isStreamConnected) {
      try { await ttsAdapter.disconnectStream(); } catch (e) { /* ignore */ }
    }

    if (this.sttAdapter) {
      try { await this.sttAdapter.dispose(); } catch (e) { /* ignore */ }
      this.sttAdapter = null;
    }
  }
}

module.exports = { PlaygroundConversation, STATE };
