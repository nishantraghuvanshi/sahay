'use strict';

const TransportPort = require('../../core/ports/transport');
const { openCall, captureField, closeCall, recordTurn } = require('../../core/call/lifecycle');
const {
  buildInboundVariables,
  INTAKE_FIELDS,
} = require('../../use-cases/medication-adherence/inbound-context');
const { EVENT_TYPES } = require('../../core/events/types');
const logger = require('../../utils/logger');

/**
 * Vapi Transport Adapter
 *
 * Translates Vapi webhooks and WebSocket events into domain events
 * that the conversation engine understands. Also builds Vapi assistant
 * configs from the active strategy and provider config.
 *
 * This is what makes the orchestrator swappable — swap this adapter
 * for a LiveKitTransportAdapter and the engine is untouched.
 */
class VapiTransportAdapter extends TransportPort {
  constructor(providerRegistry) {
    super();
    this.providerRegistry = providerRegistry;
    this.engine = null;
    this.webhookUrl = null;
  }

  /**
   * Start the transport — set up Express routes and WebSocket handlers.
   *
   * @param {Object} server - HTTP server instance
   * @param {Object} engine - ConversationEngine instance
   * @param {Object} config - { wss, app, providersConfig, strategy, webhookUrl }
   */
  async start(server, engine, config) {
    this.engine = engine;
    this.webhookUrl = config.webhookUrl;
    this.strategy = config.strategy;
    this.repository = config.repository;
    this.providersConfig = config.providersConfig;
    const { wss, app } = config;

    // --- WebSocket route: /api/stt ---
    // Vapi connects here and streams 2-channel PCM audio. Only wired when
    // STT is bridged — a native STT provider is transcribed by Vapi itself
    // and never dials in here.
    if (this.providerRegistry.isBridged('stt')) {
      wss.on('connection', async (ws, req) => {
        logger.log('stt_connect', { url: req.url });

        let sttAdapter;
        try {
          sttAdapter = this.providerRegistry.getActiveSTT();
          const sttConfig = this.providerRegistry.getSTTConfig();
          await sttAdapter.init(sttConfig, process.env);
        } catch (err) {
          logger.error('stt_init_error', err);
          ws.close(1011, 'STT init failed');
          return;
        }

        ws.on('message', async (data, isBinary) => {
          try {
            if (isBinary) {
              // Binary frame = audio chunk
              await sttAdapter.transcribe(data, (transcript, isFinal, channel) => {
                const response = {
                  type: 'transcriber-response',
                  transcription: transcript,
                  channel: channel || 'customer',
                  transcriptType: isFinal ? 'final' : 'partial',
                };
                if (ws.readyState === 1) ws.send(JSON.stringify(response));
              });
            } else {
              // Text frame = JSON config message
              const message = JSON.parse(data.toString());
              if (message.type === 'start') {
                logger.log('stt_started', { sampleRate: message.sampleRate });
              }
            }
          } catch (err) {
            logger.error('stt_message_error', err);
          }
        });

        ws.on('close', async () => {
          logger.log('stt_disconnect');
          try { await sttAdapter.dispose(); } catch (e) { /* ignore */ }
        });

        ws.on('error', (err) => logger.error('stt_ws_error', err));
      });
    } else {
      logger.log('route_skipped_native_provider', {
        type: 'stt',
        provider: this.providerRegistry.getActiveProviderNames().stt,
      });
    }

    // --- HTTP route: /llm/chat/completions ---
    // Vapi sends OpenAI-compatible chat completion requests. Only wired
    // when LLM is bridged — a native LLM provider is called by Vapi
    // directly and never posts here.
    if (this.providerRegistry.isBridged('llm')) {
      app.post('/llm/chat/completions', async (req, res) => {
        const llmAdapter = this.providerRegistry.getActiveLLM();
        const llmConfig = this.providerRegistry.getLLMConfig();
        try {
          const response = await llmAdapter.chatCompletion(req.body, llmConfig, process.env);
          res.json(response);
        } catch (err) {
          logger.error('llm_error', err);
          res.status(500).json({ error: err.message });
        }
      });
    } else {
      logger.log('route_skipped_native_provider', {
        type: 'llm',
        provider: this.providerRegistry.getActiveProviderNames().llm,
      });
    }

    // --- HTTP route: /api/tts/:provider ---
    // Vapi sends voice-request with text to synthesize. Only wired when
    // TTS is bridged — a native TTS provider is synthesized by Vapi
    // directly and never posts here.
    if (this.providerRegistry.isBridged('tts')) {
      app.post('/api/tts/:provider', async (req, res) => {
        const ttsAdapter = this.providerRegistry.getActiveTTS();
        const ttsConfig = this.providerRegistry.getTTSConfig();
        try {
          const rawPcm = await ttsAdapter.synthesize(req.body, ttsConfig, process.env);
          res.set('Content-Type', 'application/octet-stream');
          res.send(rawPcm);
        } catch (err) {
          logger.error('tts_error', err);
          res.status(500).json({ error: err.message });
        }
      });
    } else {
      logger.log('route_skipped_native_provider', {
        type: 'tts',
        provider: this.providerRegistry.getActiveProviderNames().tts,
      });
    }

    // --- HTTP route: /webhook ---
    // Vapi sends server messages (end-of-call, tool-call, call-started, etc.)
    app.post('/webhook', async (req, res) => {
      const message = req.body.message || req.body;
      const eventBus = this.engine.getEventBus();

      logger.log('webhook_received', {
        type: message.type,
        call_id: message.call?.id,
      });

      try {
        switch (message.type) {
          // Inbound: Vapi asks who is calling and what assistant to answer
          // with. Hard 7.5s budget — deterministic reads only, no model call.
          case 'assistant-request': {
            const started = Date.now();
            const assistant = await this._buildInboundAssistant(message);
            logger.log('assistant_request_answered', {
              ms: Date.now() - started,
              call_id: message.call?.id,
            });
            return res.json({ assistant });
          }

          case 'call-started':
            await eventBus.emit(EVENT_TYPES.CONVERSATION_STARTED, {
              callId: message.call?.id,
              phone: message.call?.customer?.number,
            });
            break;

          case 'tool-call': {
            const callId = message.call?.id;
            const toolName = message.tool?.name;
            const args = message.tool?.arguments || {};

            await eventBus.emit(EVENT_TYPES.TOOL_CALLED, {
              callId,
              tool: toolName,
              args,
            });

            if (toolName === 'capture_field') {
              await this._captureField(callId, args);
            }

            await recordTurn({
              repository: this.repository,
              callId,
              role: 'assistant',
              toolCalls: [{ name: toolName, arguments: args }],
            });
            break;
          }

          // UNVERIFIED: 'transcript' / 'role' / 'transcriptType' are this
          // project's best reading of Vapi's documented per-turn transcript
          // shape, not confirmed against a live account. Only final
          // transcripts are persisted — partials would otherwise duplicate
          // the same turn as it's refined.
          case 'transcript': {
            if (message.transcriptType === 'final' && message.transcript) {
              await recordTurn({
                repository: this.repository,
                callId: message.call?.id,
                role: message.role,
                content: message.transcript,
              });
            }
            break;
          }

          case 'end-of-call-report': {
            const callData = message.call || {};
            const transcript = message.transcript || '';
            const analysis = message.analysis || {};

            await eventBus.emit(EVENT_TYPES.CONVERSATION_ENDED, {
              callData: {
                callId: callData.id,
                phone: callData.customer?.number,
                toolCalls: callData.toolCalls || [],
                // Needed by the escalation alert plugin (caregiver_contact) and
                // by the pilot metrics (parent_id).
                variables: callData.assistantOverrides?.variableValues
                  || message.assistantOverrides?.variableValues
                  || {},
                transcript,
                analysis,
                endedReason: callData.endedReason,
                duration: callData.durationSeconds,
                cost: callData.cost,
                recordingUrl: this._extractRecordingUrl(message),
              },
            });

            // A missing session (e.g. an outbound call before Task 3 opened
            // one) is expected, not an error — closeCall logs and returns
            // rather than letting endSession's throw escape the handler.
            await closeCall({
              repository: this.repository,
              callId: callData.id,
              endedReason: callData.endedReason,
            });
            break;
          }

          default:
            // Unknown event type — log but don't error
            logger.log('webhook_unknown_type', { type: message.type });
        }
      } catch (err) {
        logger.error('webhook_handler_error', err);

        // assistant-request is the one webhook with a caller waiting on the
        // other end. Answering {status:"ok"} would hand Vapi no assistant and
        // hide the failure; `error` is the documented shape and is visible.
        if (message.type === 'assistant-request') {
          return res.status(200).json({ error: 'Could not resolve caller' });
        }
      }

      res.status(200).json({ status: 'ok' });
    });

    logger.log('transport_started', { transport: 'vapi', webhookUrl: this.webhookUrl });
  }

  /**
   * Write a captured intake field to the session, turn by turn.
   *
   * This is what makes fields_so_far non-empty before the call ends, so a
   * resumed call opens holding what was already said instead of nothing.
   * Delegates to the shared lifecycle module — see its docstring for the
   * validation and tolerance rules.
   *
   * @param {string} callId
   * @param {Object} args - { field, value } from the tool call
   * @private
   */
  async _captureField(callId, args) {
    const { field, value } = args;
    await captureField({
      repository: this.repository,
      callId,
      field,
      value,
      allowedFields: INTAKE_FIELDS.map((f) => f.key),
    });
  }

  /**
   * Pull the call recording URL out of an end-of-call-report message.
   *
   * UNVERIFIED: Vapi's report may carry a mono `recordingUrl` and/or a
   * `stereoRecordingUrl` inside `artifact` — this codebase has not
   * confirmed either field name against a live account. The plain
   * (mono) URL is preferred when both are present; null when neither is.
   *
   * @param {Object} message - Vapi end-of-call-report message
   * @returns {string|null}
   * @private
   */
  _extractRecordingUrl(message) {
    const artifact = message.artifact || message.call?.artifact || {};
    return artifact.recordingUrl || artifact.stereoRecordingUrl || null;
  }

  /**
   * Answer an inbound assistant-request with a context-loaded assistant.
   *
   * Resolves the caller to a patient and, if they dropped a call inside the
   * resume window, to that session — then returns a transient assistant in
   * the matching mode with their context substituted into its first message.
   *
   * A session row is opened for THIS call too, so a drop here is itself
   * resumable.
   *
   * Runs inside Vapi's hard 7.5s assistant-request budget: deterministic
   * reads only, no model call.
   *
   * @param {Object} message - Vapi assistant-request message
   * @returns {Promise<Object>} Transient Vapi assistant config
   * @private
   */
  async _buildInboundAssistant(message) {
    const phone =
      message.call?.from?.phoneNumber || message.call?.customer?.number || null;

    const resolution = await openCall({
      repository: this.repository,
      phone,
      direction: 'inbound',
      callId: message.call?.id || null,
    });

    const language = resolution.patient?.language || 'hi';
    const variables = buildInboundVariables(resolution, language);

    return this.buildAssistantConfig(
      this.strategy,
      this.providersConfig,
      this.webhookUrl,
      { mode: resolution.mode, variables }
    );
  }

  /**
   * Build the Vapi assistant configuration from the active strategy and providers.
   *
   * @param {Object} strategy - Active ConversationStrategy
   * @param {Object} providers - Provider config
   * @param {string} webhookUrl - Public URL for webhooks
   * @param {Object} [opts] - { mode, variables } for inbound and resume
   * @returns {Object} Vapi assistant config
   */
  buildAssistantConfig(strategy, providers, webhookUrl, opts = {}) {
    const mode = opts.mode || 'outbound';
    const variables = opts.variables || {};
    const activeStt = providers.active.stt;
    const activeLlm = providers.active.llm;
    const activeTts = providers.active.tts;
    const strategyConfig = strategy.getConfig();

    // Whether Vapi runs each provider itself (native) or calls back into
    // this server (bridge) is what ProviderRegistry.isBridged tracks — not
    // the provider's name. Branching on the name (as this method used to
    // for "openai") silently produced the wrong shape the moment a bridge
    // provider had a name this method didn't special-case.
    const isSttBridged = this.providerRegistry.isBridged('stt');
    const isLlmBridged = this.providerRegistry.isBridged('llm');
    const isTtsBridged = this.providerRegistry.isBridged('tts');

    const systemMessage = {
      role: 'system',
      content: strategy.buildSystemPrompt({ ...strategy.getVariables(), ...variables }, mode),
    };

    // Build transcriber config
    let transcriber;
    if (isSttBridged) {
      transcriber = {
        provider: 'custom-transcriber',
        server: { url: `${webhookUrl.replace(/^http/, 'ws')}/api/stt` },
      };
    } else {
      // Native shape: Vapi runs the provider itself, naming it by our
      // config key (matches the vendor identifier for deepgram).
      const stt = providers.stt[activeStt];
      transcriber = {
        provider: activeStt,
        model: stt.model,
        language: stt.language,
      };
    }

    // Build model (LLM) config
    let model;
    if (isLlmBridged) {
      const llm = providers.llm[activeLlm];
      model = {
        provider: 'custom-llm',
        model: llm.model,
        url: `${webhookUrl}/llm/chat/completions`,
        messages: [systemMessage],
        temperature: llm.temperature,
        maxTokens: llm.max_tokens,
        // Vapi rejects a top-level `tools` property (400: "property tools
        // should not exist"). They belong on the model — the native branch
        // below always had this right; the bridged branch did not, so the
        // assistant was being created with no tools at all.
        tools: [...strategy.getTools(), { type: 'endCall' }],
      };
    } else {
      // Native shape: Vapi calls the provider itself. No native LLM
      // provider is configured today, but the branch follows isBridged
      // (not a provider name) so a future one is not silently mis-shaped.
      const llm = providers.llm[activeLlm];
      model = {
        provider: activeLlm,
        model: llm.model,
        temperature: llm.temperature,
        maxTokens: llm.max_tokens,
        messages: [systemMessage],
        tools: [...strategy.getTools(), { type: 'endCall' }],
      };
    }

    // Build voice (TTS) config
    let voice;
    if (isTtsBridged) {
      voice = {
        provider: 'custom-voice',
        server: { url: `${webhookUrl}/api/tts/${activeTts}` },
      };
    } else if (activeTts === 'elevenlabs') {
      // UNVERIFIED: 'provider: "11labs"' is Vapi's documented identifier
      // for ElevenLabs (per the plan this task was scoped from) — not
      // something this codebase has confirmed against a live Vapi call.
      // Flagged rather than silently trusted, per this project's history
      // of assumed vendor payload shapes.
      const el = providers.tts.elevenlabs;
      voice = {
        provider: '11labs',
        voiceId: el.voice_id,
        model: el.model,
      };
    } else {
      throw new Error(
        `No native voice shape mapping for tts provider "${activeTts}" — add one before selecting it.`
      );
    }

    // Build first message with variables substituted
    const firstMessage = strategy.buildFirstMessage(
      { ...strategy.getVariables(), ...variables },
      mode
    );

    return {
      name: 'Voxi',
      transcriber,
      model,
      voice,
      firstMessage,
      firstMessageInterruptionsEnabled: false,  // Don't let user interrupt the greeting
      voicemailMessage: 'नमस्ते, मैं आशा बोल रही हूँ। बाद में फिर से संपर्क करेंगे। धन्यवाद।',
      silenceTimeoutSeconds: strategyConfig.silenceTimeoutSeconds,
      maxDurationSeconds: strategyConfig.maxDurationSeconds,
      backgroundSound: strategyConfig.backgroundSound,
      backgroundDenoisingEnabled: strategyConfig.denoiseEnabled,
      // Turn-taking: when the assistant starts speaking after user pauses
      startSpeakingPlan: {
        waitSeconds: 0.4,  // 400ms pause before responding (elderly-friendly)
        smartEndpointingPlan: {
          provider: 'vapi',
        },
      },
      // Turn-taking: when the assistant stops on user interruption
      // Barge-in is on by default; this tunes HOW READILY it triggers.
      // Shapes verified against docs.vapi.ai/customization/voice-pipeline-configuration
      // after Vapi rejected `enabled`, `sensitivity` and `backchannelingEnabled`
      // outright — those properties do not exist and never configured anything.
      //
      // numWords: 2 selects transcription-based detection instead of raw VAD, so
      // a cough or a throat-clear does not cut the agent off mid-sentence. It
      // costs 200-500ms versus VAD, which is the right trade for an elderly
      // caller who is easy to talk over.
      //
      // voiceSeconds is deliberately absent: it only applies when numWords is 0.
      //
      // acknowledgementPhrases stops a listening noise from being treated as an
      // interruption. "हाँ" is deliberately NOT in this list — it is the actual
      // answer to "क्या आपने दवाई ले ली है?", and the one word this call exists
      // to hear must never be classed as a filler.
      stopSpeakingPlan: {
        numWords: 2,
        backoffSeconds: 1.0,
        acknowledgementPhrases: ['अच्छा', 'ठीक', 'ठीक है', 'हम्म', 'जी', 'ओके', 'okay'],
      },
      server: { url: `${webhookUrl}/webhook` },
      // Recording is deliberately enabled — previously nothing set this, so
      // whether a call was recorded depended on an unverified account
      // default. Explicit, not left to Vapi's default.
      //
      // Deliberately NOT adding a recording-disclosure line to the prompt:
      // the owner has decided against that for now. Do not "fix" this by
      // adding one — that's a product decision, not an oversight.
      //
      // UNVERIFIED: 'artifactPlan.recordingEnabled' is this project's best
      // reading of Vapi's documented shape, not something confirmed against
      // a live account (same caveat as the '11labs' voice provider string
      // above).
      artifactPlan: {
        recordingEnabled: true,
      },
      analysisPlan: {
        summaryPlan: {
          messages: [
            { role: 'system', content: 'Summarize the call in 1-2 sentences.' },
          ],
        },
        structuredDataPlan: {
          schema: {
            type: 'object',
            properties: {
              outcome: {
                type: 'string',
                description:
                  'CONFIRMED, DENIED, UNCLEAR, ESCALATED_SYMPTOM, ESCALATED_DISTRESS, INCOMPLETE, or NO_ANSWER',
              },
              reason: { type: 'string', description: 'Brief reason for the outcome' },
            },
          },
        },
      },
    };
  }

  /**
   * Dispatch an outbound call via Vapi API.
   *
   * @param {string} assistantId - Vapi assistant ID
   * @param {string} phoneNumber - E.164 phone number
   * @param {Object} variables - Per-call variables
   * @returns {Object} Call object
   */
  async createCall(assistantId, phoneNumber, variables = {}) {
    const apiKey = process.env.VAPI_PRIVATE_KEY;
    if (!apiKey) throw new Error('Missing env var: VAPI_PRIVATE_KEY');

    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        assistantId,
        customer: { number: phoneNumber },
        assistantOverrides: { variableValues: variables },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vapi createCall error (${response.status}): ${errorText}`);
    }

    const call = await response.json();
    logger.log('call_dispatched', {
      call_id: call.id,
      assistant_id: assistantId,
      phone: phoneNumber,
    });

    // Dispatching the call is the primary effect; opening a session is
    // bookkeeping so a dropped dose call is resumable. Never let a
    // persistence failure undo a call that already went out.
    await this._openOutboundSession(call, phoneNumber);

    return call;
  }

  /**
   * Open a session for an outbound call, so a drop is resumable like an
   * inbound one. Never creates a patient — outbound dials a number we
   * already chose, so an unmatched number just means no session.
   *
   * @param {Object} call - Vapi call object returned by createCall
   * @param {string} phoneNumber
   * @private
   */
  async _openOutboundSession(call, phoneNumber) {
    await openCall({
      repository: this.repository,
      phone: phoneNumber,
      direction: 'outbound',
      callId: call.id,
    });
  }
}

module.exports = VapiTransportAdapter;
