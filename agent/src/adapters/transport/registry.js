'use strict';

const { loadProvidersConfig } = require('../../core/config/loader');
const VapiTransportAdapter = require('./vapi');
const ElevenLabsTransportAdapter = require('./elevenlabs');
const PlaygroundTransportAdapter = require('./playground');

/**
 * Transport name → adapter class.
 *
 * To add an orchestrator:
 *   1. Create src/adapters/transport/<name>.js implementing TransportPort
 *   2. Add it here
 *   3. Add a config block under `transport:` in config/providers.yaml
 *   4. Set active.transport to its name
 *
 * `playground` is registered here but is never `active.transport` — it is
 * not a phone orchestrator to swap in, it is TransportRegistry's second
 * real implementation, always available alongside whichever transport is
 * active, and instantiated directly by server.js for the /playground
 * WebSocket route.
 */
const TRANSPORT_ADAPTERS = {
  vapi: VapiTransportAdapter,
  elevenlabs: ElevenLabsTransportAdapter,
  playground: PlaygroundTransportAdapter,
};

/**
 * Transport Registry
 *
 * Selects the orchestrator adapter from config, mirroring ProviderRegistry.
 *
 * TransportPort has always named Vapi, LiveKit and Pipecat as peers, but
 * server.js constructed VapiTransportAdapter directly — making the orchestrator
 * the one component that could not be swapped without a code change. This is
 * the seam that closes that gap.
 */
class TransportRegistry {
  /**
   * @param {Object} providerRegistry - Passed through to the transport adapter,
   *   which needs it to resolve STT/LLM/TTS when bridging.
   */
  constructor(providerRegistry) {
    this.config = loadProvidersConfig();
    this.providerRegistry = providerRegistry;
  }

  /** @returns {string[]} Registered transport names */
  getAvailableTransports() {
    return Object.keys(TRANSPORT_ADAPTERS);
  }

  /** @returns {string} The configured active transport name */
  getActiveTransportName() {
    return this.config.active.transport;
  }

  /** @returns {Object} Config block for the active transport */
  getTransportConfig() {
    return this.config.transport[this.config.active.transport];
  }

  /**
   * Instantiate a transport adapter by name.
   * @param {string} name
   * @returns {Object} TransportPort implementation
   */
  getTransport(name) {
    const AdapterClass = TRANSPORT_ADAPTERS[name];
    if (!AdapterClass) {
      throw new Error(
        `Unknown transport: "${name}". Available: ${this.getAvailableTransports().join(', ')}`
      );
    }
    // The loaded config goes in too. Adapters that need it only inside
    // start() were unusable from scripts, which resolve a transport and dial
    // without ever starting a server.
    return new AdapterClass(this.providerRegistry, this.config);
  }

  /** @returns {Object} The active transport adapter */
  getActiveTransport() {
    return this.getTransport(this.getActiveTransportName());
  }
}

module.exports = TransportRegistry;
module.exports.TRANSPORT_ADAPTERS = TRANSPORT_ADAPTERS;
