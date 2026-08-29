'use strict';

const {
  loadProvidersConfig,
  PROVIDER_TYPES,
} = require('../../core/config/loader');

// Adapter implementations
const SarvamSTTAdapter = require('./stt/sarvam');
const SarvamLLMAdapter = require('./llm/sarvam');
const GroqLLMAdapter = require('./llm/groq');
const OpenAILLMAdapter = require('./llm/openai');
const SarvamTTSAdapter = require('./tts/sarvam');

/**
 * Provider name → adapter class, per type.
 *
 * Only `bridge` providers appear here. A `native` provider is run by the
 * orchestrator itself, so registering an adapter for one would be a lie —
 * ProviderRegistry checks both directions at construction.
 */
const BRIDGE_ADAPTERS = {
  stt: { sarvam: SarvamSTTAdapter },
  llm: { sarvam: SarvamLLMAdapter, groq: GroqLLMAdapter, openai: OpenAILLMAdapter },
  tts: { sarvam: SarvamTTSAdapter },
};

/**
 * Provider Registry
 *
 * Reads providers.yaml and instantiates the active STT/LLM/TTS adapters.
 * This is the bridge between config-driven provider selection and
 * the hexagonal port/adapter architecture.
 *
 * It also enforces the integration contract, at construction, in both
 * directions: every `bridge` provider must have an adapter, and no `native`
 * provider may have one. Previously the config advertised deepgram, openai and
 * elevenlabs with no adapter behind any of them — selectable in config, fatal
 * at boot, and green in the test suite.
 */
class ProviderRegistry {
  constructor() {
    this.config = loadProvidersConfig();
    this.env = process.env;

    const unbacked = this.findUnbackedBridgeProviders();
    if (unbacked.length > 0) {
      throw new Error(
        `providers.yaml declares bridge providers with no adapter: ${unbacked.join(', ')}. ` +
          `Either implement the adapter or mark them integration: native.`
      );
    }

    const stray = this.findNativeProvidersWithAdapters();
    if (stray.length > 0) {
      throw new Error(
        `providers.yaml marks these native but an adapter is registered: ${stray.join(', ')}. ` +
          `Native providers are run by the orchestrator and must not be bridged.`
      );
    }
  }

  /**
   * Bridge providers in config that have no registered adapter.
   * @returns {string[]} e.g. ["stt.deepgram"]
   */
  findUnbackedBridgeProviders() {
    const missing = [];
    for (const type of PROVIDER_TYPES) {
      for (const [name, entry] of Object.entries(this.config[type])) {
        if (entry.integration === 'bridge' && !BRIDGE_ADAPTERS[type][name]) {
          missing.push(`${type}.${name}`);
        }
      }
    }
    return missing;
  }

  /**
   * Native providers in config that nonetheless have a registered adapter.
   * @returns {string[]}
   */
  findNativeProvidersWithAdapters() {
    const stray = [];
    for (const type of PROVIDER_TYPES) {
      for (const [name, entry] of Object.entries(this.config[type])) {
        if (entry.integration === 'native' && BRIDGE_ADAPTERS[type][name]) {
          stray.push(`${type}.${name}`);
        }
      }
    }
    return stray;
  }

  /**
   * Whether the active provider of a type runs through this server.
   * @param {string} type - stt | llm | tts
   * @returns {boolean}
   */
  isBridged(type) {
    return this.config[type][this.config.active[type]].integration === 'bridge';
  }

  /**
   * Instantiate a named bridge adapter.
   * @param {string} type - stt | llm | tts
   * @param {string} name - Provider name
   * @returns {Object} Adapter instance
   */
  getBridgeAdapter(type, name) {
    const entry = this.config[type]?.[name];
    if (!entry) {
      throw new Error(
        `Unknown ${type} provider: "${name}". Available: ${Object.keys(this.config[type] || {}).join(', ')}`
      );
    }
    if (entry.integration === 'native') {
      throw new Error(
        `${type}.${name} is integration: native — it is run by the orchestrator and has no bridge adapter.`
      );
    }
    return new BRIDGE_ADAPTERS[type][name]();
  }

  getActiveSTT() {
    return this.getBridgeAdapter('stt', this.config.active.stt);
  }

  getActiveLLM() {
    return this.getBridgeAdapter('llm', this.config.active.llm);
  }

  getActiveTTS() {
    return this.getBridgeAdapter('tts', this.config.active.tts);
  }

  getActiveProviderNames() {
    return { ...this.config.active };
  }

  getSTTConfig() {
    return this.config.stt[this.config.active.stt];
  }

  getLLMConfig() {
    return this.config.llm[this.config.active.llm];
  }

  getTTSConfig() {
    return this.config.tts[this.config.active.tts];
  }
}

module.exports = ProviderRegistry;
module.exports.BRIDGE_ADAPTERS = BRIDGE_ADAPTERS;
