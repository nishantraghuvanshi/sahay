'use strict';

const crypto = require('crypto');
const TransportPort = require('../../core/ports/transport');
const { verifyElevenLabsSignature } = require('./elevenlabs-signature');
const { captureField } = require('../../core/call/lifecycle');
const { INTAKE_FIELDS } = require('../../use-cases/medication-adherence/inbound-context');
const { EVENT_TYPES } = require('../../core/events/types');
const logger = require('../../utils/logger');

const API = 'https://api.elevenlabs.io';

// What the agent shipped with and what every recorded call so far used.
// Overridden by transport.elevenlabs.llm in providers.yaml.
const DEFAULT_LLM = 'gemini-2.5-flash';

// 0 turns internal reasoning off. gemini-2.5-flash otherwise thinks by
// default, which the agent was paying for on every single turn.
const DEFAULT_THINKING_BUDGET = 0;

// How long the agent waits before deciding the caller has finished speaking.
// 'normal' is the shipped default; 'eager' trades interruption risk for
// latency, which matters because this product calls people who pause mid
// sentence. Enum confirmed against the API schema, not guessed.
const TURN_EAGERNESS = ['patient', 'normal', 'eager'];
const DEFAULT_TURN_EAGERNESS = 'normal';
// Seconds to wait for a reply before re-engaging. Sent alongside eagerness so
// that setting one does not drop the other from the turn object.
const DEFAULT_TURN_TIMEOUT = 7;

// What ElevenLabs is asked to pull out of the transcript once the call ends.
// Spells out the promise-versus-taken distinction because that is the mistake
// the agent's own report_outcome intermittently makes — "मैं ले लूँगी" filed as
// CONFIRMED — and a second reader that repeats it is no backstop at all.
const DOSE_OUTCOME_EXTRACTION = [
  'The outcome of this dose call, as exactly one of:',
  'CONFIRMED, DENIED, UNCLEAR, ESCALATED_SYMPTOM, ESCALATED_DISTRESS, INCOMPLETE.',
  'CONFIRMED only if the patient said they have ALREADY taken this dose.',
  'A promise or an intention — "I will take it now", "I will take it after food" —',
  'is DENIED, not CONFIRMED, however willing they sounded.',
  'DENIED if they have not taken it yet. UNCLEAR if they answered but their',
  'meaning could not be established. ESCALATED_SYMPTOM if they reported a medical',
  'emergency, ESCALATED_DISTRESS if they expressed hopelessness or a wish to stop',
  'treatment. INCOMPLETE if the conversation broke down or the patient was never',
  'reached. If you cannot tell, answer UNCLEAR rather than guessing.',
].join(' ');

/**
 * ElevenLabs' own system tools.
 *
 * They have to be declared because a PATCH that sends `tools` REPLACES the
 * whole list: installing our two webhook tools cleared the three the source
 * agent carried, and nothing said so. The agent was left with a prompt that
 * instructs `end_call` roughly ten times and no such tool in existence.
 *
 * The model's response to being ordered to call a tool it does not have was to
 * SAY it — transcripts show a literal "[end_call]" spoken to the caller and
 * repeated until the turn limit. On the first real call the agent therefore
 * never hung up; `endedReason` was "Call ended by remote party", which is to
 * say the human gave up and ended it themselves.
 *
 * They belong INSIDE `tools`, not in a sibling `built_in_tools`. Established
 * by probing the live API, because the two fields both exist and the schema
 * does not say which wins:
 *   - built_in_tools sent WITHOUT tools  -> applied, existing tools preserved
 *   - built_in_tools sent WITH tools     -> silently discarded, 200 OK
 *   - system tools sent inside tools     -> applied, and the server derives
 *                                           built_in_tools from them
 * We always send `tools`, so only the third form works. The second is what we
 * were doing, and it fails exactly the way `platform_settings` did: accepted,
 * ignored, no error.
 *
 * Shapes copied from the live source agent rather than written from the
 * schema, since the contracts this branch got wrong were all written from
 * schemas. No transfer_* or subagent tools: there is nobody to transfer an
 * elderly caller to, and a transfer_to_number would let the agent dial out.
 */
const SYSTEM_TOOLS = [
  { system_tool_type: 'end_call' },
  { system_tool_type: 'language_detection', only_at_conversation_start: false },
  // Empty message deliberately: leaving a recording about someone's medication
  // on a machine anyone in the house can play back is a privacy leak. Detect,
  // hang up, and let the outcome record that the patient was unreachable.
  { system_tool_type: 'voicemail_detection', voicemail_message: '' },
].map((params) => ({
  type: 'system',
  name: params.system_tool_type,
  description: '',
  response_timeout_secs: 20,
  params,
}));

/**
 * ElevenLabs Agents as a call orchestrator.
 *
 * Unlike the Vapi adapter, the LLM is NOT ours: ElevenLabs runs its own model,
 * so /llm/chat/completions is never called on this path. The engine is reached
 * only through webhook tools. That is the deliberate trade — see
 * docs/superpowers/specs/2026-08-30-elevenlabs-outbound-transport-design.md.
 *
 * Outbound only. Inbound calls are not handled: while this transport is active
 * the number still rings, but nothing here answers it.
 */
class ElevenLabsTransportAdapter extends TransportPort {
  /**
   * @param {Object} providerRegistry
   * @param {Object} [providersConfig] - the loaded providers.yaml. Supplied by
   *   TransportRegistry so the adapter is usable without start(): scripts
   *   resolve a transport and dial immediately, and reading phone_number_id
   *   only inside start() made every scripted outbound call fail.
   */
  constructor(providerRegistry, providersConfig = null) {
    super();
    this.providerRegistry = providerRegistry;
    this.engine = null;
    this.webhookUrl = null;
    this.agentId = process.env.ELEVENLABS_AGENT_ID || null;
    this.phoneNumberId =
      providersConfig?.transport?.elevenlabs?.phone_number_id || null;
    // The largest single contributor to how long a caller waits. Measured on a
    // real call: LLM ttfb 1029-1700ms of a 2252-3882ms silence-to-first-audio,
    // against ~160ms for TTS and ~30ms for ASR. Configurable so candidates can
    // be compared without a code change, like every other provider here.
    this.llm = providersConfig?.transport?.elevenlabs?.llm || DEFAULT_LLM;
    // ?? not ||, so an explicit 0 survives.
    this.thinkingBudget =
      providersConfig?.transport?.elevenlabs?.thinking_budget ?? DEFAULT_THINKING_BUDGET;
    this.turnEagerness =
      providersConfig?.transport?.elevenlabs?.turn_eagerness || DEFAULT_TURN_EAGERNESS;
    this.turnTimeout =
      providersConfig?.transport?.elevenlabs?.turn_timeout ?? DEFAULT_TURN_TIMEOUT;
  }

  get apiKey() {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('Missing env var: ELEVENLABS_API_KEY');
    return key;
  }

  async start(server, engine, config) {
    this.engine = engine;
    this.webhookUrl = config.webhookUrl;
    this.strategy = config.strategy;
    this.repository = config.repository;
    this.agentId = process.env.ELEVENLABS_AGENT_ID || null;
    // start()'s config wins when present, so a caller can override the
    // configured number; otherwise keep what the constructor resolved.
    this.phoneNumberId =
      config.providersConfig?.transport?.elevenlabs?.phone_number_id || this.phoneNumberId;
    this.llm = config.providersConfig?.transport?.elevenlabs?.llm || this.llm;
    this.thinkingBudget =
      config.providersConfig?.transport?.elevenlabs?.thinking_budget ?? this.thinkingBudget;
    this.turnEagerness =
      config.providersConfig?.transport?.elevenlabs?.turn_eagerness || this.turnEagerness;
    this.turnTimeout =
      config.providersConfig?.transport?.elevenlabs?.turn_timeout ?? this.turnTimeout;

    const KNOWN_TOOLS = new Set(['report_outcome', 'capture_field']);

    if (config.app) {
      config.app.post('/el/tools/:name', async (req, res) => {
        const name = req.params.name;

        // Shared-secret check first: this endpoint is public through the
        // tunnel, and report_outcome can raise a real family alert, so it
        // cannot be left open to anyone who finds the URL. Fails closed if
        // the secret is not configured — an unset secret must never be
        // treated as "no check required".
        const expected = process.env.ELEVENLABS_WEBHOOK_SECRET;
        if (!expected || req.get('X-Kinvox-Token') !== expected) {
          // Deliberately says nothing about which part was wrong.
          logger.log('el_tool_unauthorized', { name });
          return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        // Allow-list rather than pass-through. Forwarding an arbitrary name
        // into the event bus would let anyone who finds the URL emit events
        // the engine acts on.
        if (!KNOWN_TOOLS.has(name)) {
          logger.log('el_tool_unknown', { name });
          return res.status(404).json({ ok: false, error: 'unknown tool' });
        }

        try {
          // kinvox_call_id rides in the body alongside the tool's real
          // arguments — it's a request_body_schema property ElevenLabs
          // populates from a dynamic variable (see _toolDeclaration), not a
          // separate call-metadata field the way Vapi's message.call.id is.
          // Pulled out here so `args` handed to the engine and to
          // _captureField is exactly the tool's own arguments, nothing else.
          const { kinvox_call_id: callId, ...args } = req.body || {};

          await this.engine.getEventBus().emit(EVENT_TYPES.TOOL_CALLED, {
            callId: callId || null,
            tool: name,
            args,
          });

          if (name === 'capture_field') {
            await this._captureField(callId || null, args);
          }

          logger.log('el_tool_dispatched', { name });
          return res.json({ ok: true });
        } catch (err) {
          logger.log('el_tool_failed', { name, error: err.message });
          // Fixed message only: err.message could leak internals to this
          // public, unauthenticated-by-name caller.
          return res.status(500).json({ ok: false, error: 'tool dispatch failed' });
        }
      });

      // --- HTTP route: /el/post-call ---
      // ElevenLabs' post-call webhook, fired once after the conversation
      // ends. This is the only place a call's transcript, duration, cost
      // and tool history all land together — nothing here writes to the
      // `calls` table directly. Emitting CONVERSATION_ENDED and letting the
      // engine's own handler derive the outcome, persist it, check
      // escalation and notify plugins (engine.js's _setupEventHandlers) is
      // what the Vapi 'end-of-call-report' case does too; duplicating that
      // logic here would risk a second, out-of-sync write to the same row.
      config.app.post('/el/post-call', async (req, res) => {
        // Two accepted proofs, because there are two senders in play.
        //
        // ElevenLabs signs every delivery itself — we do not choose those
        // headers, so the X-Kinvox-Token gate the tool route uses cannot
        // apply here. A webhook configured in the dashboard with a custom
        // header is still honoured, so the token path stays.
        //
        // Fails closed either way: with neither secret set, nothing is
        // accepted. An unset secret must never read as "no check required".
        if (!this._authorizePostCall(req)) {
          logger.log('el_post_call_unauthorized', {
            // Header NAMES only, never values — enough to see at a glance
            // whether a real delivery arrived shaped differently than
            // expected, without writing a signature into the log.
            signaturePresent: Boolean(req.get('ElevenLabs-Signature')),
            tokenPresent: Boolean(req.get('X-Kinvox-Token')),
            rawBodyCaptured: Boolean(req.rawBody),
          });
          return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        // The webhook wraps the conversation object in an envelope:
        //   { type, event_timestamp, data: { conversation_id, ... } }
        // The bare object is what GET /v1/convai/conversations/{id} returns.
        // Reading conversation_id off the top level — which is what this
        // route did — yields undefined on every real delivery, so each one
        // was refused with 400 and nothing persisted.
        const envelope = req.body || {};
        const body = envelope.data && typeof envelope.data === 'object' ? envelope.data : envelope;

        // post_call_audio carries no transcript. A 400 would put ElevenLabs
        // into a retry loop over a delivery that can never succeed.
        if (envelope.type && envelope.type !== 'post_call_transcription') {
          logger.log('el_post_call_ignored', { type: envelope.type });
          return res.json({ ok: true, ignored: envelope.type });
        }

        const callId = body.conversation_id;

        // Refuse rather than emit an event with no call identity: nothing
        // downstream (deriveOutcome, save()) has anything to key on.
        if (!callId) {
          logger.log('el_post_call_rejected', { reason: 'no conversation_id' });
          return res.status(400).json({ ok: false, error: 'conversation_id required' });
        }

        try {
          await this.engine.getEventBus().emit(EVENT_TYPES.CONVERSATION_ENDED, {
            callData: this._mapPostCallData(body),
          });
          logger.log('el_post_call_processed', { callId });
          return res.json({ ok: true });
        } catch (err) {
          logger.log('el_post_call_failed', { callId, error: err.message });
          return res.status(500).json({ ok: false, error: 'post-call processing failed' });
        }
      });
    }

    logger.log('transport_started', { transport: 'elevenlabs', webhookUrl: this.webhookUrl });

    if (this.agentId && this.strategy && typeof this.strategy.getTools === 'function') {
      await this._patchAgent(this.agentId, this.buildAssistantConfig(this.strategy, {}, this.webhookUrl));
    } else if (!this.agentId) {
      // Loud, because the alternative is a transport that starts fine and never
      // works. Run `npm run setup-elevenlabs` and record the printed id.
      logger.log('el_agent_id_missing', { hint: 'run npm run setup-elevenlabs' });
    }
  }

  /**
   * Push the current config to the agent.
   *
   * Called on every boot rather than by a setup script, because the tool URLs
   * embed the tunnel origin and the free ngrok tier rotates it on restart. The
   * source agent still points at a host that stopped resolving weeks ago; tool
   * calls failed silently the whole time. Re-patching makes that unreachable.
   */
  async _patchAgent(agentId, config) {
    const res = await fetch(`${API}/v1/convai/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs agent patch failed (${res.status}): ${await res.text()}`);
    }
    logger.log('el_agent_patched', { agentId, webhookUrl: this.webhookUrl });
    return res.json();
  }

  /**
   * Write a captured intake field to the session, turn by turn.
   *
   * Mirrors vapi.js's `_captureField` exactly — same lifecycle helper, same
   * allowed-field list — because the underlying state (a session's
   * fields_so_far) is transport-agnostic. Kept as a thin wrapper here rather
   * than shared code because the two adapters differ in how they get
   * `callId` and `args` out of their native payload; the call into
   * `captureField()` itself already tolerates a missing/unknown session
   * (see lifecycle.js), which matters here since this transport opens no
   * session for outbound calls.
   *
   * @param {string|null} callId
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
   * Decide whether a POST /el/post-call request really came from ElevenLabs.
   *
   * Accepts either proof:
   *   - a valid ElevenLabs-Signature HMAC over the raw body, which the service
   *     always sends and which requires ELEVENLABS_POST_CALL_SECRET (the
   *     wsec_… value shown once when the workspace webhook is created);
   *   - the X-Kinvox-Token shared secret, for a webhook configured in the
   *     dashboard with a custom header.
   *
   * Neither secret configured means no request is authorized. The endpoint is
   * public through the tunnel and drives outcome persistence and escalation,
   * so open-by-default is not an option.
   *
   * @param {import('express').Request} req
   * @returns {boolean}
   * @private
   */
  _authorizePostCall(req) {
    const signingSecret = process.env.ELEVENLABS_POST_CALL_SECRET;
    if (
      signingSecret &&
      verifyElevenLabsSignature({
        header: req.get('ElevenLabs-Signature'),
        rawBody: req.rawBody,
        secret: signingSecret,
      })
    ) {
      return true;
    }

    const token = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (!token) return false;
    const provided = req.get('X-Kinvox-Token');
    if (typeof provided !== 'string' || provided.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(token, 'utf8'));
  }

  /**
   * Map ElevenLabs' post-call webhook payload onto the transport-agnostic
   * CONVERSATION_ENDED shape (see vapi.js's 'end-of-call-report' handler for
   * the sibling mapping this mirrors).
   *
   * Field provenance verified against the cached OpenAPI spec rather than
   * guessed:
   *   - duration/cost/endedReason/phone come from GetConversationResponseModel's
   *     `metadata` (ConversationHistoryMetadataCommonModel: call_duration_secs,
   *     cost, termination_reason; phone from the phone_call sub-object's
   *     external_number).
   *   - toolCalls is flattened out of each transcript turn's own `tool_calls`
   *     array (ConversationHistoryTranscriptCommonModel nests them per-turn;
   *     Vapi's callData.toolCalls is already a flat list, and
   *     medication-adherence/outcomes.js's checkToolCalls() reads a flat
   *     list — {name, arguments} per call, arguments a JSON string it parses).
   *   - transcript is rendered as "role: message" lines, which
   *     extractCallerSpeech() in outcomes.js already knows how to split on
   *     ("user"/"agent" both match its speaker-prefix regex).
   *   - recordingUrl has no documented field anywhere in the spec (unlike
   *     Vapi's artifact.recordingUrl) — left null rather than invented.
   *
   * @param {Object} body - req.body from POST /el/post-call
   * @returns {Object} callData, shaped for EVENT_TYPES.CONVERSATION_ENDED
   * @private
   */
  _mapPostCallData(body) {
    const metadata = body.metadata || {};
    const turns = Array.isArray(body.transcript) ? body.transcript : [];

    const toolCalls = [];
    for (const turn of turns) {
      for (const call of turn.tool_calls || []) {
        toolCalls.push({ name: call.tool_name, arguments: call.params_as_json });
      }
    }

    return {
      callId: body.conversation_id,
      phone: metadata.phone_call?.external_number || null,
      toolCalls,
      variables: body.conversation_initiation_client_data?.dynamic_variables || {},
      transcript: turns.map((t) => `${t.role}: ${t.message || ''}`).join('\n'),
      analysis: body.analysis || {},
      endedReason: metadata.termination_reason || null,
      duration: metadata.call_duration_secs ?? null,
      cost: metadata.cost ?? null,
      recordingUrl: null,
    };
  }

  /**
   * One ElevenLabs webhook tool from one strategy tool.
   *
   * The shape is taken from a live tool on the source agent, not from the prose
   * docs, which do not specify it. `execution_mode` mirrors tools.json's `async`
   * flag, but the two blocking-mode values are otherwise inferred, not
   * documented — ElevenLabs's OpenAPI spec gives the enum
   * ('immediate' | 'post_tool_speech' | 'async') with no descriptions at all.
   * We use 'immediate' rather than 'post_tool_speech' for report_outcome:
   * the source agent's `send_guardian_alert` tool paired 'post_tool_speech'
   * with a `pre_tool_speech` field, i.e. it blocks but speaks a filler line
   * first ("let me just note that down...") before the write lands. Two of
   * report_outcome's outcomes alert the patient's family, and we do not want
   * the agent narrating that write before it has landed, so 'immediate' —
   * blocking, no filler — is the closer fit.
   */
  _toolDeclaration(tool, webhookUrl) {
    const fn = tool.function || tool;
    const params = fn.parameters || { type: 'object', properties: {}, required: [] };
    return {
      type: 'webhook',
      name: fn.name,
      description: fn.description,
      response_timeout_secs: 10,
      execution_mode: tool.async === true ? 'async' : 'immediate',
      api_schema: {
        kind: 'webhook',
        url: `${webhookUrl}/el/tools/${fn.name}`,
        method: 'POST',
        // Proves the call came from our agent and not from anyone who found the
        // tunnel URL. report_outcome can raise a family medical alert, so the
        // endpoint cannot be open.
        request_headers: { 'X-Kinvox-Token': process.env.ELEVENLABS_WEBHOOK_SECRET || '' },
        path_params_schema: {},
        query_params_schema: null,
        request_body_schema: {
          type: 'object',
          description: fn.description,
          properties: {
            ...params.properties,
            // The webhook has no other way to know which call it's for —
            // ElevenLabs' documented dynamic variables
            // (system__call_duration_secs, system__time) carry no
            // conversation id. `dynamic_variable` here tells ElevenLabs to
            // populate this property from the kinvox_call_id dynamic
            // variable createCall() sets, rather than asking the model to
            // supply it.
            //
            // Exactly one of description / dynamic_variable /
            // is_system_provided / constant_value / is_omitted may be set on
            // a property — a live PATCH 400'd with "Can only set one of: ..."
            // when this carried dynamic_variable alongside the other three,
            // which had been copied from a misreading of the live agent's
            // schema. This one is bound to the dynamic variable createCall
            // sends, so dynamic_variable is the one it gets, and it
            // therefore carries no description.
            kinvox_call_id: {
              type: 'string',
              dynamic_variable: 'kinvox_call_id',
            },
          },
          required: params.required || [],
        },
      },
    };
  }

  /**
   * The agent patch.
   *
   * Generated from the active strategy every time rather than hand-maintained,
   * so a guardrail edit lands on both transports or neither. SETUP.md records a
   * stale config/assistant.json shipping v1 guardrails while the repo ran v4;
   * this is how that does not happen again.
   */
  buildAssistantConfig(strategy, providers, webhookUrl) {
    // Interpolate placeholders, not values. strategy.getVariables() returns the
    // config's demo defaults, so passing them here froze one script — a real call
    // greeted the patient by the sample name and asked about the sample medicine.
    // Substituting `{{key}}` for each key turns the strategy's output into an
    // ElevenLabs template that dynamic_variables fills per call.
    //
    // Not every default is safe to placeholder-ify, though — found by reading
    // strategy.js's own use of these variables, not by assuming every key is
    // plain text:
    //   - Keys whose default is "" (context_line, fields_summary, missing_field)
    //     gate an empty-vs-non-empty branch in buildFirstMessage/buildSystemPrompt
    //     ("is there a context line at all"). A non-empty `{{context_line}}`
    //     placeholder would flip that branch on every call and leave a literal,
    //     unfilled placeholder sitting in text meant to be spoken.
    //   - `alert_delivered` isn't text at all: _resolveAlertDeliveredLine reads
    //     it as `vars.alert_delivered ? trueLine : falseLine`. Any non-empty
    //     string — including a `{{alert_delivered}}` placeholder — is truthy,
    //     so it would always pick the "already told your family" line even
    //     though no such delivery has happened, which is exactly the false
    //     claim the guardrail exists to prevent.
    //   - `alert_delivered_true_line` / `alert_delivered_false_line` are never
    //     substituted into the prompt via their own `{key}` tag — they are only
    //     read BY _resolveAlertDeliveredLine and folded into `alert_delivered_line`,
    //     which is what's actually spoken. Placeholder-ifying them would bake a
    //     raw `{{alert_delivered_false_line}}` string into the guardrail text,
    //     with no per-call dynamic_variable able to reach it.
    // Excluded BY NAME, never by "its default happens to be empty". The old
    // rule was `v === '' || CONTROL_FLOW_KEYS.has(k)`, which covered these
    // three empty-string keys as a side effect — and would have silently
    // covered every future variable that starts out empty, freezing it at boot
    // and never filling it per call. next_call_line is exactly that shape: it
    // is empty precisely when there is no next dose to promise.
    const CONTROL_FLOW_KEYS = new Set([
      // Gate an empty-vs-non-empty branch in buildFirstMessage/buildSystemPrompt.
      // A non-empty "{{context_line}}" would flip the branch on every call and
      // leave a literal placeholder in text meant to be spoken.
      'context_line',
      'fields_summary',
      'missing_field',
      // Read as a boolean by _resolveAlertDeliveredLine; any non-empty string
      // is truthy, so a placeholder would always select the "already told your
      // family" line — the false claim the guardrail exists to prevent.
      'alert_delivered',
      // Never substituted via their own tag; folded into alert_delivered_line.
      'alert_delivered_true_line',
      'alert_delivered_false_line',
    ]);
    const defaults = typeof strategy.getVariables === 'function' ? strategy.getVariables() : {};
    const placeholders = Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [
        k,
        CONTROL_FLOW_KEYS.has(k) ? v : `{{${k}}}`,
      ])
    );
    // Defaults ElevenLabs substitutes for any variable a caller omits.
    //
    // Only the keys that were actually turned into `{{key}}` above get one:
    // a default for a control-flow key would be meaningless, and one for an
    // empty-string key would flip the empty-check branch it gates.
    //
    // This is the belt to createCall's braces. Without it, a caller that
    // forgets caregiver_name leaves "{{caregiver_name}}" sitting in the
    // escalation reassurance line — the single sentence whose purpose is an
    // honest claim about contacting the patient's family.
    const templated = Object.fromEntries(
      Object.entries(defaults).filter(([k]) => placeholders[k] === `{{${k}}}`)
    );

    const eagerness = this.turnEagerness || DEFAULT_TURN_EAGERNESS;
    if (!TURN_EAGERNESS.includes(eagerness)) {
      // Fail here rather than let the API reject the whole boot patch, which
      // would leave the agent on whatever config it happened to have.
      throw new Error(
        `Invalid turn_eagerness "${eagerness}". Expected one of: ${TURN_EAGERNESS.join(', ')}`
      );
    }

    return {
      conversation_config: {
        agent: {
          language: 'hi',
          first_message: strategy.buildFirstMessage(placeholders),
          ...(Object.keys(templated).length
            ? { dynamic_variables: { dynamic_variable_placeholders: templated } }
            : {}),
          prompt: {
            prompt: strategy.buildSystemPrompt(placeholders),
            llm: this.llm || DEFAULT_LLM,
            // A dose call is a scripted branch, not a puzzle. Thinking costs
            // time on every turn, and the v6 transcript shows it being spoken
            // aloud to a patient when it leaks.
            thinking_budget: this.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
            enable_reasoning_summary: false,
            tools: [
              ...strategy.getTools().map((t) => this._toolDeclaration(t, webhookUrl)),
              ...SYSTEM_TOOLS,
            ],
          },
        },
        turn: {
          turn_eagerness: eagerness,
          turn_timeout: this.turnTimeout ?? DEFAULT_TURN_TIMEOUT,
        },
        tts: {
          voice_id: 'QTKSa2Iyv0yoxvXY2V8a',
          model_id: 'eleven_v3_conversational',
        },
      },
      // A SIBLING of conversation_config, not a child of it.
      //
      // The PATCH body declares conversation_config and platform_settings as
      // separate top-level properties, and a live GET returns platform_settings
      // at the top level. Nested inside conversation_config it was still
      // accepted with a 200 — that object allows additional properties — so the
      // webhook id was silently discarded and the agent kept
      // post_call_webhook_id: null. Nothing failed; it simply never worked.
      //
      // That is the worst shape this class of bug can take, and it would have
      // surfaced the moment someone registered the workspace webhook and
      // concluded the feature was finished.
      platform_settings: {
        // Extracted from the transcript after the call, independently of any
        // tool the agent did or did not invoke mid-conversation. deriveOutcome
        // reads it as tier 2, below a real report_outcome and above keyword
        // matching — which is what stops a call the agent forgot to report
        // being recorded NO_ANSWER when it plainly established something.
        //
        // Dict shape, established by probing the live API; the
        // analysis_items.data_collection variant in the schema returns a 500.
        data_collection: {
          dose_outcome: {
            type: 'string',
            description: DOSE_OUTCOME_EXTRACTION,
          },
        },
        ...(process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID
          ? {
              workspace_overrides: {
                webhooks: {
                  post_call_webhook_id: process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID,
                  events: ['transcript'],
                },
              },
            }
          : {}),
      },
    };
  }

  /**
   * Dispatch an outbound call.
   *
   * Endpoint and required fields come from the ElevenLabs OpenAPI spec
   * (/v1/convai/twilio/outbound-call requires agent_id, agent_phone_number_id
   * and to_number), not from the prose docs, which describe only the dashboard
   * flow.
   */
  /**
   * @see TransportPort#getAssistantId
   * @returns {string} the Kinvox-owned ElevenLabs agent id
   */
  getAssistantId() {
    // this.agentId is captured at start(); the env var is the fallback for
    // callers (scripts) that never started a transport.
    const id = this.agentId || process.env.ELEVENLABS_AGENT_ID;
    if (!id) {
      throw new Error(
        'Missing env var: ELEVENLABS_AGENT_ID. Run `npm run setup-elevenlabs` ' +
          'to duplicate the source agent into a Kinvox-owned copy, and record ' +
          'the id it prints.'
      );
    }
    return id;
  }

  async createCall(assistantId, phoneNumber, variables = {}) {
    if (!this.phoneNumberId) {
      throw new Error(
        'Missing phone_number_id for the elevenlabs transport. Set it under ' +
          'transport.elevenlabs in config/providers.yaml — an outbound call has ' +
          'no number to call from without it.'
      );
    }

    // Minted here, not read back from ElevenLabs: their OpenAPI spec exposes
    // only system__call_duration_secs and system__time as dynamic
    // variables — no conversation id — so the webhook tool calls would
    // otherwise have no way to say which call they belong to. Sent as a
    // dynamic variable so _toolDeclaration's kinvox_call_id property (bound
    // via `dynamic_variable`) gets it populated on every tool call.
    const kinvoxCallId = crypto.randomUUID();

    const res = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: assistantId,
        agent_phone_number_id: this.phoneNumberId,
        to_number: phoneNumber,
        conversation_initiation_client_data: {
          dynamic_variables: { ...variables, kinvox_call_id: kinvoxCallId },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs createCall error (${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    logger.log('el_call_created', { conversationId: body.conversation_id, kinvoxCallId });
    // Returned alongside the API's own response so a caller can correlate
    // this dispatch with the tool calls and post-call webhook that follow.
    return { ...body, kinvox_call_id: kinvoxCallId };
  }
}

module.exports = ElevenLabsTransportAdapter;
