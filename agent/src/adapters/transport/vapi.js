'use strict';

const TransportPort = require('../../core/ports/transport');
const { openCall, captureField, closeCall, recordTurn } = require('../../core/call/lifecycle');
const {
  buildInboundVariables,
  INTAKE_FIELDS,
} = require('../../use-cases/medication-adherence/inbound-context');
const { EVENT_TYPES } = require('../../core/events/types');
const logger = require('../../utils/logger');
const {
  vapiSecretAuth,
  authenticateVapiWebSocket,
  verifyVapiSecret,
  extractVapiSecret,
} = require('../../core/middleware/auth');
const { createRateLimiter } = require('../../core/middleware/rate-limit');

// Fixed-window budgets, generous enough that real Vapi traffic for a handful
// of concurrent calls is never throttled — a false-positive throttle drops a
// live call, which is worse than the cost-amplification risk these guard
// against. See rate-limit.js for why a fixed window is enough precision here.
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const WEBHOOK_RATE_LIMIT_MAX = 600; // ~10/s — one call emits several webhook events
const STT_CONNECT_RATE_LIMIT_WINDOW_MS = 60_000;
const STT_CONNECT_RATE_LIMIT_MAX = 100; // new STT socket connections per IP per minute
const LLM_RATE_LIMIT_WINDOW_MS = 60_000;
const LLM_RATE_LIMIT_MAX = 300; // chat-completion calls per IP per minute
const TTS_RATE_LIMIT_WINDOW_MS = 60_000;
const TTS_RATE_LIMIT_MAX = 300; // synthesize calls per IP per minute

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

    // One limiter instance per route, held for the transport's lifetime —
    // a limiter created per-request would never accumulate a window's worth
    // of hits and would rate-limit nothing.
    this._webhookRateLimiter = createRateLimiter({
      windowMs: WEBHOOK_RATE_LIMIT_WINDOW_MS,
      max: WEBHOOK_RATE_LIMIT_MAX,
      name: 'webhook',
    });
    this._sttConnectRateLimiter = createRateLimiter({
      windowMs: STT_CONNECT_RATE_LIMIT_WINDOW_MS,
      max: STT_CONNECT_RATE_LIMIT_MAX,
      name: 'stt_connect',
    });
    this._llmRateLimiter = createRateLimiter({
      windowMs: LLM_RATE_LIMIT_WINDOW_MS,
      max: LLM_RATE_LIMIT_MAX,
      name: 'llm',
    });
    this._ttsRateLimiter = createRateLimiter({
      windowMs: TTS_RATE_LIMIT_WINDOW_MS,
      max: TTS_RATE_LIMIT_MAX,
      name: 'tts',
    });
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
        const remoteAddress = req.socket?.remoteAddress || 'unknown';
        if (!this._sttConnectRateLimiter.allow(remoteAddress)) {
          ws.close(1008, 'rate limited');
          return;
        }

        // Unauthenticated by default: this socket opens a billed STT session
        // per connection, with no operator API key possible on a route Vapi
        // itself must reach. See auth.js / safety-guard.js.
        if (!authenticateVapiWebSocket(req)) {
          ws.close(4001, 'Unauthorized: invalid or missing Vapi secret');
          return;
        }

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

        // Vapi announces the real audio format in its 'start' control message.
        // This used to be hardcoded to 2 while only sampleRate was logged, so a
        // mono stream would be de-interleaved as if stereo — every other sample
        // taken, yielding noise that Sarvam accepts and silently declines to
        // transcribe. No error, healthy socket, empty transcript, and the call
        // dies on silence-timed-out. Trust what the transport says it is sending.
        let streamChannels = 2;

        // Same story as streamChannels above: the configured rate
        // (providers.yaml) is only a fallback. null here means "nothing
        // announced yet" — sarvam.js falls back to its own configured
        // default rather than us guessing one.
        let streamSampleRate = null;

        ws.on('message', async (data, isBinary) => {
          try {
            if (isBinary) {
              // Binary frame = audio chunk. Channel 0 is the customer.
              await sttAdapter.transcribe(data, (transcript, isFinal, channel) => {
                const response = {
                  type: 'transcriber-response',
                  transcription: transcript,
                  channel: channel || 'customer',
                  transcriptType: isFinal ? 'final' : 'partial',
                };
                if (ws.readyState === 1) ws.send(JSON.stringify(response));
              }, { channels: streamChannels, sampleRate: streamSampleRate });
            } else {
              // Text frame = JSON config message
              const message = JSON.parse(data.toString());
              if (message.type === 'start') {
                if (Number.isInteger(message.channels) && message.channels > 0) {
                  streamChannels = message.channels;
                }
                if (Number.isInteger(message.sampleRate) && message.sampleRate > 0) {
                  streamSampleRate = message.sampleRate;
                }
                logger.log('stt_started', {
                  sampleRate: message.sampleRate,
                  channels: message.channels,
                  usingChannels: streamChannels,
                  configuredSampleRate: this.providerRegistry.getSTTConfig().sample_rate,
                });
                if (
                  message.sampleRate &&
                  message.sampleRate !== this.providerRegistry.getSTTConfig().sample_rate
                ) {
                  // Used to log this mismatch and then transcribe at the
                  // configured rate anyway. streamSampleRate now carries the
                  // announced rate through to sttAdapter.transcribe() above,
                  // so this only needs to report that it was corrected.
                  logger.log('stt_sample_rate_corrected', {
                    transportSays: message.sampleRate,
                    configuredFallback: this.providerRegistry.getSTTConfig().sample_rate,
                    usingSampleRate: streamSampleRate,
                  });
                }
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
      app.post(
        '/llm/chat/completions',
        this._llmRateLimiter.middleware,
        vapiSecretAuth,
        async (req, res) => {
        const llmAdapter = this.providerRegistry.getActiveLLM();
        const llmConfig = this.providerRegistry.getLLMConfig();

        // Vapi's custom-LLM contract is SSE, not a blocking JSON response —
        // https://docs.vapi.ai/customization/tool-calling-integration: the
        // response must be `Content-Type: text/event-stream`, one
        // `data: <chunk>\n\n` per OpenAI-format chunk, terminated with
        // `data: [DONE]\n\n`. The blocking `chatCompletion()` used to be
        // called here instead of the already-built `chatCompletionStream()`
        // (present on both the openai and sarvam adapters), so Vapi never
        // got a stream to parse. `getActiveLLM()` returns whichever adapter
        // is configured, so this works for either without naming one.
        //
        // The adapter's onToken callback only exposes accumulated text
        // deltas and a final merged tool_calls array (see openai.js /
        // sarvam.js), not the underlying provider's raw chunks, so this
        // re-encodes each piece as its own OpenAI-format SSE chunk rather
        // than piping a raw stream through — functionally equivalent, since
        // Vapi merges tool-call deltas by index either way.
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        try {
          const result = await llmAdapter.chatCompletionStream(
            req.body,
            llmConfig,
            process.env,
            (textDelta) => {
              res.write(`data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: textDelta } }],
              })}\n\n`);
            }
          );

          if (result.tool_calls) {
            const toolCallDeltas = result.tool_calls.map((tc, index) => ({
              index,
              id: tc.id,
              type: tc.type,
              function: tc.function,
            }));
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: { tool_calls: toolCallDeltas }, finish_reason: 'tool_calls' }],
            })}\n\n`);
          }

          res.write('data: [DONE]\n\n');
          res.end();
        } catch (err) {
          logger.error('llm_error', err);
          if (res.headersSent) {
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.status(500).json({ error: err.message });
          }
        }
        }
      );
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
      app.post('/api/tts/:provider', this._ttsRateLimiter.middleware, vapiSecretAuth, async (req, res) => {
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
      // A forged end-of-call-report or tool-call here writes fake rows into
      // `calls` / fabricated symptom text into a patient's record — this
      // route had no auth at all before vapiSecretAuth existed. It stays a
      // 200 on rejection (not the 401 the other bridge routes use): a real
      // caller is waiting on this response, and NFR-6 requires errors to be
      // data, never a stalled transport, on this specific endpoint.
      const remoteAddress = req.ip || req.socket?.remoteAddress || 'unknown';
      if (!this._webhookRateLimiter.allow(remoteAddress)) {
        logger.log('webhook_rate_limited', { remoteAddress });
        return res.status(200).json({ ok: false, error: 'rate limited' });
      }

      if (!verifyVapiSecret(extractVapiSecret(req))) {
        logger.log('vapi_secret_rejected', { path: '/webhook', method: 'POST' });
        return res.status(200).json({ ok: false, error: 'Invalid or missing Vapi secret' });
      }

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

          // UNOBSERVED: an audit of two real phone calls (see
          // tests/fixtures/vapi-real/) found Vapi never actually sends
          // 'call-started' — it sends 'status-update' with
          // status: 'in-progress' instead (handled below). Kept here in
          // case some other Vapi configuration does emit it.
          case 'call-started':
            await eventBus.emit(EVENT_TYPES.CONVERSATION_STARTED, {
              callId: message.call?.id,
              phone: message.call?.customer?.number,
            });
            break;

          // Confirmed against real traffic (tests/fixtures/vapi-real/) —
          // Vapi's actual start-of-call signal on the phone path.
          // 'ended' is deliberately a log-only branch: end-of-call-report
          // always follows and already owns closeCall/CONVERSATION_ENDED,
          // so duplicating that here would just double the work.
          case 'status-update': {
            if (message.status === 'in-progress') {
              await eventBus.emit(EVENT_TYPES.CONVERSATION_STARTED, {
                callId: message.call?.id,
                phone: message.call?.customer?.number,
              });
            } else if (message.status === 'ended') {
              logger.log('vapi_status_update_ended', {
                call_id: message.call?.id,
                endedReason: message.endedReason,
              });
            } else {
              logger.log('vapi_status_update', {
                call_id: message.call?.id,
                status: message.status,
              });
            }
            break;
          }

          // Confirmed against real traffic (tests/fixtures/vapi-real/).
          // Nothing meaningful to do with these yet — logged so they're
          // distinguishable from a genuinely unknown event type.
          case 'speech-update':
            logger.log('vapi_speech_update', {
              call_id: message.call?.id,
              status: message.status,
              role: message.role,
            });
            break;

          case 'assistant.started':
            logger.log('vapi_assistant_started', { call_id: message.call?.id });
            break;

          // Vapi's real server message for a tool invocation is 'tool-calls'
          // (plural) — see https://docs.vapi.ai/server-url/events. The
          // singular 'tool-call' handled here too is kept only for backward
          // compatibility with whatever shape this code was originally
          // written against; it has never been confirmed against a live
          // payload and may not be a real Vapi event at all.
          case 'tool-calls':
          case 'tool-call': {
            const callId = message.call?.id;
            const calls = this._extractToolCalls(message);
            const results = [];

            for (const call of calls) {
              await eventBus.emit(EVENT_TYPES.TOOL_CALLED, {
                callId,
                tool: call.name,
                args: call.arguments,
              });

              if (call.name === 'capture_field') {
                await this._captureField(callId, call.arguments);
              }

              await recordTurn({
                repository: this.repository,
                callId,
                role: 'assistant',
                toolCalls: [{ name: call.name, arguments: call.arguments }],
              });

              // Per https://docs.vapi.ai/tools/custom-tools, the response
              // must be { results: [{ toolCallId, result }] } with a
              // single-line string result — the previous fallback to the
              // generic { status: 'ok' } gave Vapi no toolCallId to match,
              // so the assistant stalled waiting on every tool call.
              results.push({ toolCallId: call.toolCallId, result: 'ok' });
            }

            return res.status(200).json({ results });
          }

          // UNVERIFIED: 'transcript' / 'role' / 'transcriptType' are this
          // project's best reading of Vapi's documented per-turn transcript
          // shape, not confirmed against a live account — an audit of two
          // real phone calls (tests/fixtures/vapi-real/) never observed
          // this event at all; only 'speech-update' (started/stopped, no
          // text) arrived. Only final transcripts are persisted — partials
          // would otherwise duplicate the same turn as it's refined.
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
                // Read from message.* FIRST. In real captured payloads
                // (tests/fixtures/vapi-real/call-sequences.json) endedReason,
                // durationSeconds and cost are top-level on the message and
                // null inside message.call — reading only the nested copy meant
                // duration and cost were never persisted, and closeCall below
                // received endedReason undefined. session-status.js maps an
                // unrecognised reason to 'dropped', and a dropped session is
                // what makes a call resumable, so every completed call looked
                // resumable for the whole resume window. The nested fallback is
                // kept because other Vapi configurations may populate it.
                endedReason: message.endedReason ?? callData.endedReason,
                duration: message.durationSeconds ?? callData.durationSeconds,
                cost: message.cost ?? callData.cost,
                recordingUrl: this._extractRecordingUrl(message),
              },
            });

            // A missing session (e.g. an outbound call before Task 3 opened
            // one) is expected, not an error — closeCall logs and returns
            // rather than letting endSession's throw escape the handler.
            await closeCall({
              repository: this.repository,
              callId: callData.id,
              endedReason: message.endedReason ?? callData.endedReason,
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
   * Normalize the tool-call list out of a 'tool-calls' (or legacy
   * 'tool-call') webhook message.
   *
   * UNVERIFIABLE: docs.vapi.ai never returned the exact field carrying the
   * call list on a real request body — 'toolCalls' and 'toolCallList' are
   * both plausible, and the legacy singular event carries one call under
   * 'tool' with no list at all. Every shape is read defensively rather than
   * guessed at, and which one matched is logged so a single live call
   * settles it — see agent/.superpowers/sdd/audit-vapi.md §4.
   *
   * @param {Object} message - Vapi webhook message
   * @returns {Array<{toolCallId: string|null, name: string, arguments: Object}>}
   * @private
   */
  _extractToolCalls(message) {
    const list = message.toolCalls || message.toolCallList;
    if (Array.isArray(list)) {
      logger.log('tool_calls_shape_matched', {
        shape: message.toolCalls ? 'toolCalls' : 'toolCallList',
      });
      return list.map((call) => {
        const fn = call.function || call;
        return {
          toolCallId: call.id || call.toolCallId || null,
          name: fn.name,
          arguments: this._normalizeToolArgs(fn.arguments),
        };
      });
    }

    if (message.tool) {
      logger.log('tool_calls_shape_matched', { shape: 'tool' });
      return [{
        toolCallId: message.toolCallId || message.tool.id || null,
        name: message.tool.name,
        arguments: this._normalizeToolArgs(message.tool.arguments),
      }];
    }

    logger.log('tool_calls_shape_unmatched', { keys: Object.keys(message) });
    return [];
  }

  /**
   * A tool call's arguments may already be an object or a JSON string
   * (the OpenAI-style shape 'toolCalls' would carry sends it as a string).
   * @private
   */
  _normalizeToolArgs(args) {
    if (typeof args === 'string') {
      try {
        return JSON.parse(args);
      } catch (err) {
        logger.error('tool_call_args_parse_error', err);
        return {};
      }
    }
    return args || {};
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
    // Same story as endedReason/durationSeconds/cost above: the real capture
    // carries recordingUrl at the top level of message AND inside
    // message.artifact — this already worked because it happened to check
    // the nested copy, but reading top-level first keeps all four fields
    // consistent about which shape wins rather than three agreeing and one
    // differing by accident.
    const artifact = message.artifact || message.call?.artifact || {};
    return (
      message.recordingUrl ||
      artifact.recordingUrl ||
      artifact.stereoRecordingUrl ||
      null
    );
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
  /**
   * Build a Vapi squad — the multi-state form of the call.
   *
   * Shape per docs.vapi.ai/squads-example: { members: [{ assistant,
   * assistantDestinations }] }, first member handles the call, the rest are
   * reached by transfer. Returned from assistant-request as `{ squad }` rather
   * than `{ assistant }`, which is what lets inbound stay dynamic per caller —
   * a Vapi Workflow attaches to the phone number instead and would have cost
   * the resolve-caller design entirely.
   *
   * Each member is built by buildAssistantConfig with only its prompt
   * overridden, so providers, secrets, hooks and timeouts cannot drift between
   * members.
   *
   * @param {Object} strategy
   * @param {Object} providers
   * @param {string} webhookUrl
   * @param {Object} [opts] - { mode, variables }
   * @returns {{ members: Array }}
   */
  buildSquadConfig(strategy, providers, webhookUrl, opts = {}) {
    if (typeof strategy.buildSquadMembers !== 'function') {
      throw new Error(
        'Active strategy has no buildSquadMembers() — it cannot run as a squad. '
          + 'Use buildAssistantConfig for single-state strategies.'
      );
    }

    const variables = { ...strategy.getVariables(), ...(opts.variables || {}) };
    const members = strategy.buildSquadMembers(variables);

    const entry = members.filter((m) => m.first);
    if (entry.length !== 1) {
      throw new Error(`A squad needs exactly one entry member, found ${entry.length}.`);
    }
    // Vapi hands the call to members[0], so the entry member must lead.
    const ordered = [...entry, ...members.filter((m) => !m.first)];

    return {
      members: ordered.map((member) => ({
        assistant: this.buildAssistantConfig(strategy, providers, webhookUrl, {
          ...opts,
          variables,
          name: member.label,
          systemPrompt: member.systemPrompt,
          // Only the entry member greets. A first message on an internal
          // member would narrate the state change to the patient — the seam a
          // state machine exists to hide.
          firstMessage: member.first ? undefined : '',
          firstMessageMode: member.first ? undefined : 'assistant-waits-for-user',
        }),
        assistantDestinations: member.destinations.map((d) => ({
          type: 'assistant',
          assistantName: d.label,
          // Silent handoff. "Please hold while I transfer you" is right for a
          // call centre and wrong here: these are steps inside one
          // conversation, and announcing them makes the machinery audible.
          message: '',
          description: d.description,
        })),
      })),
    };
  }

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

    // The one secret Vapi presents on every route it calls into this
    // server: server.secret (→ X-Vapi-Secret header) on the three
    // server-url shapes below, and model.headers on the custom-llm model
    // (Authorization is reserved for the custom-llm credential, so it can't
    // carry this). auth.js's vapiSecretAuth / authenticateVapiWebSocket
    // verify against the same VAPI_SECRET env var these read.
    // '' rather than undefined: JSON.stringify drops undefined-valued keys
    // on write, so a config generated with VAPI_SECRET unset would compare
    // unequal to itself after a round trip through the committed file (see
    // assistant-config-staleness.test.js) — an empty string round-trips
    // identically either way.
    const vapiSecret = process.env.VAPI_SECRET || '';

    // A squad member supplies its own already-composed prompt (built through
    // the strategy's single guardrail path). Everything else — providers,
    // secrets, hooks, timeouts — is identical for every member, which is the
    // reason this builds them rather than a parallel squad-specific builder.
    const systemMessage = {
      role: 'system',
      content:
        opts.systemPrompt
        || strategy.buildSystemPrompt({ ...strategy.getVariables(), ...variables }, mode),
    };

    // Build transcriber config
    let transcriber;
    if (isSttBridged) {
      // Belt and suspenders: `secret` asks Vapi to send X-Vapi-Secret like
      // every other server-url shape, and `?api_key=` is appended to the URL
      // itself because a WebSocket upgrade is not guaranteed to carry a
      // custom header through — authenticateVapiWebSocket (auth.js) already
      // reads api_key off the connection URL.
      const sttUrl = `${webhookUrl.replace(/^http/, 'ws')}/api/stt`;
      transcriber = {
        provider: 'custom-transcriber',
        server: {
          url: `${sttUrl}?api_key=${encodeURIComponent(vapiSecret || '')}`,
          secret: vapiSecret,
        },
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
        // Custom-llm models can't use `server.secret` (there is no `server`
        // object here) and `Authorization` is reserved for the custom-llm
        // credential per Vapi's docs, so the shared secret rides on its own
        // header instead — vapiSecretAuth reads the same header name.
        headers: { 'x-vapi-secret': vapiSecret },
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
        server: { url: `${webhookUrl}/api/tts/${activeTts}`, secret: vapiSecret },
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
      name: opts.name || 'Voxi',
      transcriber,
      model,
      voice,
      // Only the squad's entry member greets. A mid-call member that speaks a
      // first message would announce every internal state change to the
      // patient, which is exactly the seam a state machine should hide.
      firstMessage: opts.firstMessage !== undefined ? opts.firstMessage : firstMessage,
      ...(opts.firstMessageMode ? { firstMessageMode: opts.firstMessageMode } : {}),
      firstMessageInterruptionsEnabled: false,  // Don't let user interrupt the greeting
      voicemailMessage: 'नमस्ते, मैं आशा बोल रही हूँ। बाद में फिर से संपर्क करेंगे। धन्यवाद।',
      // Answer silence with a prompt, not a hangup. Three escalating
      // customer.speech.timeout hooks (docs.vapi.ai/assistants/idle-messages);
      // silenceTimeoutSeconds below is only the backstop after these have run.
      // triggerResetMode 'onUserSpeech' so a patient who answers late resets the
      // ladder instead of carrying strikes for the rest of the call.
      hooks: [
        {
          on: 'customer.speech.timeout',
          name: 'idle_gentle_prompt',
          options: {
            timeoutSeconds: strategyConfig.idlePromptSeconds,
            triggerMaxCount: 3,
            triggerResetMode: 'onUserSpeech',
          },
          // Deliberately not a repeat of the question: an elderly caller who is
          // still thinking should be given room, not asked again.
          do: [{ type: 'say', exact: 'जी, मैं सुन रही हूँ। आराम से बताइए।' }],
        },
        {
          on: 'customer.speech.timeout',
          name: 'idle_check_presence',
          options: {
            timeoutSeconds: strategyConfig.idleEscalateSeconds,
            triggerMaxCount: 2,
            triggerResetMode: 'onUserSpeech',
          },
          do: [{ type: 'say', exact: 'क्या आप वहाँ हैं?' }],
        },
        {
          on: 'customer.speech.timeout',
          name: 'idle_end_call',
          options: {
            timeoutSeconds: strategyConfig.idleEndSeconds,
            triggerMaxCount: 1,
            triggerResetMode: 'onUserSpeech',
          },
          do: [
            { type: 'say', exact: 'ठीक है, मैं बाद में फिर कोशिश करूँगी। अपना ख़याल रखियेगा।' },
            { type: 'tool', tool: { type: 'endCall' } },
          ],
        },
      ],
      silenceTimeoutSeconds: strategyConfig.silenceTimeoutSeconds,
      maxDurationSeconds: strategyConfig.maxDurationSeconds,
      backgroundSound: strategyConfig.backgroundSound,
      // 'backgroundDenoisingEnabled' as a bare boolean is not a real Vapi
      // property — verified against
      // docs.vapi.ai/documentation/assistants/conversation-behavior/background-speech-denoising,
      // which documents this nested shape instead.
      backgroundSpeechDenoisingPlan: {
        smartDenoisingPlan: { enabled: strategyConfig.denoiseEnabled },
      },
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
      server: { url: `${webhookUrl}/webhook`, secret: vapiSecret },
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
      // Verified against docs.vapi.ai/assistants/call-analysis:
      // summaryPlan takes a `summaryPrompt` string (not `messages`), and
      // structuredDataPlan's schema goes under `structuredDataSchema` (not
      // `schema`) — the previous field names matched neither documented
      // shape, so both sub-plans were silently dropped.
      analysisPlan: {
        // Flat fields. Vapi rejects summaryPlan/structuredDataPlan wrappers
        // ("property summaryPrompt should not exist") — these live directly on
        // analysisPlan. https://docs.vapi.ai/assistants/call-analysis
        summaryPrompt: 'Summarize the call in 1-2 sentences.',
        structuredDataPrompt:
          'Extract the call outcome and a brief reason from the transcript.',
        structuredDataSchema: {
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
  /**
   * @see TransportPort#getAssistantId
   * @returns {string} the Vapi assistant id
   */
  getAssistantId() {
    const id = process.env.VAPI_ASSISTANT_ID;
    if (!id) {
      throw new Error(
        'Missing env var: VAPI_ASSISTANT_ID. Run `node scripts/create-assistant.js` ' +
          'and record the id it prints.'
      );
    }
    return id;
  }

  async createCall(assistantId, phoneNumber, variables = {}) {
    const apiKey = process.env.VAPI_PRIVATE_KEY;
    if (!apiKey) throw new Error('Missing env var: VAPI_PRIVATE_KEY');
    if (!process.env.VAPI_PHONE_NUMBER_ID) {
      throw new Error(
        'Missing env var: VAPI_PHONE_NUMBER_ID. Import a Twilio number into ' +
          'Vapi (POST /phone-number) and set its id here — outbound calls are ' +
          'rejected without a number to call from.'
      );
    }

    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        assistantId,
        // REQUIRED for outbound: Vapi needs to know which number to call FROM.
        // https://docs.vapi.ai/calls/outbound-calling — a call without it is
        // rejected, and free Vapi numbers cannot place outbound calls at all,
        // so this must be an imported Twilio/Vonage/Telnyx number.
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
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

  /**
   * @see TransportPort#requiredSecrets
   * @returns {Array<{name: string, why: string}>}
   */
  requiredSecrets() {
    return [
      {
        name: 'VAPI_SECRET',
        why: '/webhook, /llm/chat/completions, /api/tts/:provider and the /api/stt ' +
          'WebSocket accept anyone without it — a forged webhook can write fake ' +
          'call rows, and the bridged endpoints are a free paid-vendor-call ' +
          'amplifier. Set it and configure the same value on the Vapi ' +
          'assistant/phone number.',
      },
    ];
  }
}

module.exports = VapiTransportAdapter;
