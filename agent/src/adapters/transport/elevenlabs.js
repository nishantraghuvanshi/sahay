'use strict';

const TransportPort = require('../../core/ports/transport');
const logger = require('../../utils/logger');

const API = 'https://api.elevenlabs.io';

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
  constructor(providerRegistry) {
    super();
    this.providerRegistry = providerRegistry;
    this.engine = null;
    this.webhookUrl = null;
    this.agentId = null;
    this.phoneNumberId = null;
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
    this.agentId = process.env.ELEVENLABS_AGENT_ID || null;
    this.phoneNumberId =
      config.providersConfig?.transport?.elevenlabs?.phone_number_id || null;

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
          this.engine.getEventBus().emit(`tool:${name}`, req.body || {});
          logger.log('el_tool_dispatched', { name });
          return res.json({ ok: true });
        } catch (err) {
          logger.log('el_tool_failed', { name, error: err.message });
          // Fixed message only: err.message could leak internals to this
          // public, unauthenticated-by-name caller.
          return res.status(500).json({ ok: false, error: 'tool dispatch failed' });
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
          properties: params.properties,
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
    const variables = typeof strategy.getVariables === 'function' ? strategy.getVariables() : {};
    return {
      conversation_config: {
        agent: {
          language: 'hi',
          first_message: strategy.buildFirstMessage(variables),
          prompt: {
            prompt: strategy.buildSystemPrompt(variables),
            llm: 'gemini-2.5-flash',
            tools: strategy.getTools().map((t) => this._toolDeclaration(t, webhookUrl)),
          },
        },
        tts: {
          voice_id: 'QTKSa2Iyv0yoxvXY2V8a',
          model_id: 'eleven_v3_conversational',
        },
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
  async createCall(assistantId, phoneNumber, variables = {}) {
    if (!this.phoneNumberId) {
      throw new Error(
        'Missing phone_number_id for the elevenlabs transport. Set it under ' +
          'transport.elevenlabs in config/providers.yaml — an outbound call has ' +
          'no number to call from without it.'
      );
    }

    const res = await fetch(`${API}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: assistantId,
        agent_phone_number_id: this.phoneNumberId,
        to_number: phoneNumber,
        conversation_initiation_client_data: { dynamic_variables: variables },
      }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs createCall error (${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    logger.log('el_call_created', { conversationId: body.conversation_id });
    return body;
  }
}

module.exports = ElevenLabsTransportAdapter;
