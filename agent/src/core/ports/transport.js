'use strict';

/**
 * Transport Port (interface)
 *
 * The orchestrator adapter. Each orchestrator (Vapi, LiveKit, Pipecat)
 * implements this to translate native events into domain events and
 * domain commands back into orchestrator API calls.
 *
 * This is what makes the orchestrator swappable — the conversation engine
 * only knows TransportPort, never Vapi or LiveKit directly.
 */
class TransportPort {
  /**
   * Start the transport — begin listening for incoming connections/webhooks.
   * @param {Object} server - HTTP/WS server instance
   * @param {Object} engine - ConversationEngine instance
   * @param {Object} config - Transport config
   */
  async start(server, engine, config) {
    throw new Error('TransportPort.start() not implemented');
  }

  /**
   * Build the assistant configuration for this orchestrator.
   * @param {Object} strategy - Active ConversationStrategy
   * @param {Object} providers - Provider config
   * @param {string} webhookUrl - Public URL for webhooks
   * @returns {Object} Orchestrator-specific assistant config
   */
  buildAssistantConfig(strategy, providers, webhookUrl) {
    throw new Error('TransportPort.buildAssistantConfig() not implemented');
  }

  /**
   * The orchestrator-side id an outbound call should be placed against.
   *
   * Each orchestrator names this differently — Vapi has an assistant id from
   * VAPI_ASSISTANT_ID, ElevenLabs an agent id from ELEVENLABS_AGENT_ID — and
   * only the adapter knows which. Callers that resolved it themselves ended up
   * hardcoded to one transport: POST /api/call read VAPI_ASSISTANT_ID
   * unconditionally, so with the ElevenLabs transport active it either failed
   * for a missing Vapi variable or handed a Vapi id to ElevenLabs.
   *
   * Throws rather than returning null when unconfigured, naming the variable
   * and the script that populates it.
   *
   * @returns {string}
   */
  getAssistantId() {
    throw new Error('TransportPort.getAssistantId() not implemented');
  }

  /**
   * Dispatch an outbound call.
   * @param {string} assistantId - Orchestrator assistant ID
   * @param {string} phoneNumber - E.164 phone number
   * @param {Object} variables - Per-call variables
   * @returns {Object} Call object
   */
  async createCall(assistantId, phoneNumber, variables) {
    throw new Error('TransportPort.createCall() not implemented');
  }
}

module.exports = TransportPort;
