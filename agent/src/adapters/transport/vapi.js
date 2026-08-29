'use strict';

const TransportPort = require('../../core/ports/transport');
const { resolveInboundCall } = require('../../core/inbound/resolve-caller');
const {
  buildInboundVariables,
} = require('../../use-cases/medication-adherence/inbound-context');
const { EVENT_TYPES } = require('../../core/events/types');
const { terminalStatusFor } = require('../../core/inbound/session-status');
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
    // Vapi connects here and streams 2-channel PCM audio
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

    // --- HTTP route: /llm/chat/completions ---
    // Vapi sends OpenAI-compatible chat completion requests
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

    // --- HTTP route: /api/tts/:provider ---
    // Vapi sends voice-request with text to synthesize
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

          case 'tool-call':
            await eventBus.emit(EVENT_TYPES.TOOL_CALLED, {
              callId: message.call?.id,
              tool: message.tool?.name,
              args: message.tool?.arguments,
            });
            break;

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
              },
            });

            // Outbound calls have no session yet (Task 3 adds that), so a
            // missing session here is expected today — log it and move on
            // rather than letting endSession's throw escape the handler.
            if (callData.id && (await this.repository.getSession(callData.id))) {
              const status = terminalStatusFor(callData.endedReason);
              await this.repository.endSession(callData.id, status);
            } else {
              logger.log('session_end_skipped_unknown_session', { callId: callData.id });
            }
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

    const resolution = await resolveInboundCall({
      repository: this.repository,
      phone,
    });

    const language = resolution.patient?.language || 'hi';
    const variables = buildInboundVariables(resolution, language);

    if (resolution.patient) {
      await this.repository.createSession({
        sessionId: message.call?.id || `inbound-${Date.now()}`,
        patientId: resolution.patient.id,
        callId: message.call?.id || null,
        direction: 'inbound',
      });
    }

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

    // Build transcriber config
    let transcriber;
    if (activeStt === 'deepgram') {
      const dg = providers.stt.deepgram;
      transcriber = {
        provider: 'deepgram',
        model: dg.model,
        language: dg.language,
        smartFormat: dg.smart_format,
        endpointing: dg.endpointing,
      };
    } else {
      transcriber = {
        provider: 'custom-transcriber',
        server: { url: `${webhookUrl.replace(/^http/, 'ws')}/api/stt` },
      };
    }

    // Build model (LLM) config
    let model;
    if (activeLlm === 'openai') {
      const oai = providers.llm.openai;
      model = {
        provider: 'openai',
        model: oai.model,
        temperature: oai.temperature,
        maxTokens: oai.max_tokens,
        messages: [
          {
            role: 'system',
            content: strategy.buildSystemPrompt({ ...strategy.getVariables(), ...variables }, mode),
          },
        ],
      };
    } else {
      const llm = providers.llm[activeLlm];
      model = {
        provider: 'custom-llm',
        model: llm.model,
        url: `${webhookUrl}/llm/chat/completions`,
        messages: [
          {
            role: 'system',
            content: strategy.buildSystemPrompt({ ...strategy.getVariables(), ...variables }, mode),
          },
        ],
        temperature: llm.temperature,
        maxTokens: llm.max_tokens,
      };
    }

    // Build voice (TTS) config
    let voice;
    if (activeTts === 'elevenlabs') {
      const el = providers.tts.elevenlabs;
      voice = {
        provider: 'elevenlabs',
        voiceId: el.voice_id,
        model: el.model,
        stability: el.stability,
        similarityBoost: el.similarity_boost,
      };
    } else {
      voice = {
        provider: 'custom-voice',
        server: { url: `${webhookUrl}/api/tts/${activeTts}` },
      };
    }

    // Build first message with variables substituted
    const firstMessage = strategy.buildFirstMessage(
      { ...strategy.getVariables(), ...variables },
      mode
    );

    return {
      name: 'Elderly Medication Adherence Agent',
      transcriber,
      model,
      voice,
      firstMessage,
      firstMessageInterruptionsEnabled: false,  // Don't let user interrupt the greeting
      voicemailMessage: 'नमस्ते, मैं स्वास्थ्य सहायक से बोल रहा हूँ। बाद में फिर से संपर्क करेंगे। धन्यवाद।',
      silenceTimeoutSeconds: strategyConfig.silenceTimeoutSeconds,
      maxDurationSeconds: strategyConfig.maxDurationSeconds,
      maxIdleSeconds: strategyConfig.maxIdleSeconds,
      backgroundSound: strategyConfig.backgroundSound,
      denoiseEnabled: strategyConfig.denoiseEnabled,
      // Turn-taking: when the assistant starts speaking after user pauses
      startSpeakingPlan: {
        waitSeconds: 0.4,  // 400ms pause before responding (elderly-friendly)
        smartEndpointingPlan: {
          enabled: true,
        },
      },
      // Turn-taking: when the assistant stops on user interruption
      stopSpeakingPlan: {
        enabled: true,          // Allow barge-in
        sensitivity: 'medium',  // Don't stop on every noise (elderly may cough)
        backchannelingEnabled: true,  // Agent says "हम्म" while listening
      },
      tools: [...strategy.getTools(), { type: 'endCall' }],
      server: { url: `${webhookUrl}/webhook` },
      analysisPlan: {
        summary: 'Summarize the call in 1-2 sentences.',
        structuredData: {
          outcome: 'CONFIRMED, DENIED, UNCLEAR, ESCALATED_SYMPTOM, INCOMPLETE, or NO_ANSWER',
          reason: 'Brief reason for the outcome',
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
    try {
      const patient = await this.repository.findPatientByPhone(phoneNumber);
      if (!patient) {
        logger.log('outbound_session_skipped_unknown_patient', {
          call_id: call.id,
          phone: phoneNumber,
        });
        return;
      }

      await this.repository.createSession({
        sessionId: call.id,
        patientId: patient.id,
        callId: call.id,
        direction: 'outbound',
      });
    } catch (err) {
      logger.error('outbound_session_create_error', err);
    }
  }
}

module.exports = VapiTransportAdapter;
