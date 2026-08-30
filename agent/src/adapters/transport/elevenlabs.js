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
    logger.log('transport_started', { transport: 'elevenlabs', webhookUrl: this.webhookUrl });
  }

  buildAssistantConfig(strategy, providers, webhookUrl) {
    throw new Error('not implemented yet');
  }

  async createCall(assistantId, phoneNumber, variables = {}) {
    throw new Error('not implemented yet');
  }
}

module.exports = ElevenLabsTransportAdapter;
