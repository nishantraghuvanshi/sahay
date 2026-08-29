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
const ElevenLabsTTSAdapter = require('./tts/elevenlabs');

/**
 * Provider name → adapter class, per type.
 *
 * A `native` provider CAN appear here too now (see elevenlabs) — see the
 * comment on findNativeProvidersWithAdapters below for why that stopped
 * being a contradiction.
 */
const BRIDGE_ADAPTERS = {
  stt: { sarvam: SarvamSTTAdapter },
  llm: { sarvam: SarvamLLMAdapter, groq: GroqLLMAdapter, openai: OpenAILLMAdapter },
  tts: { sarvam: SarvamTTSAdapter, elevenlabs: ElevenLabsTTSAdapter },
};

/**
 * Provider Registry
 *
 * Reads providers.yaml and instantiates the active STT/LLM/TTS adapters.
 * This is the bridge between config-driven provider selection and
 * the hexagonal port/adapter architecture.
 *
 * It enforces one direction of the integration contract at construction:
 * every `bridge` provider must have an adapter. Previously the config
 * advertised deepgram, openai and elevenlabs with no adapter behind any of
 * them — selectable in config, fatal at boot, and green in the test suite.
 *
 * The other direction — no `native` provider may have an adapter — used to
 * be enforced here too, back when there was one transport and `native`
 * meant "we never touch this provider from our own server." That stopped
 * being true once the playground became a second transport with no
 * orchestrator of its own: elevenlabs is `integration: native` (Vapi calls
 * it directly on the phone path) AND has a registered bridge adapter (the
 * playground always bridges, because it has no other option), correctly,
 * at the same time. `integration` now describes how the ACTIVE PHONE
 * TRANSPORT reaches a provider, not whether any adapter may exist for it —
 * see getPlaygroundAdapter, which is what actually uses a native provider's
 * adapter. findNativeProvidersWithAdapters() is kept below as a query, but
 * is no longer enforced here.
 */
class ProviderRegistry {
  /**
   * @param {Object} [config] - A pre-loaded, already-validated providers
   *   config. Defaults to loadProvidersConfig() (config/providers.yaml).
   *   Overridable so the constructor's own bridge-adapter check (rule 1,
   *   see class doc) is exercisable against a config that actually violates
   *   it, without touching the real providers.yaml — see provider-modes.test.js.
   */
  constructor(config) {
    this.config = config || loadProvidersConfig();
    this.env = process.env;

    const unbacked = this.findUnbackedBridgeProviders();
    if (unbacked.length > 0) {
      throw new Error(
        `providers.yaml declares bridge providers with no adapter: ${unbacked.join(', ')}. ` +
          `Either implement the adapter or mark them integration: native.`
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
   * Native providers in config that also have a registered adapter.
   *
   * No longer treated as an error (see the class doc comment) — a native
   * provider legitimately gaining a bridge adapter is exactly what letting
   * the playground use it looks like. Kept as a query for callers that
   * still want to know.
   *
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

  /**
   * Get the active provider's adapter for the playground, bridging it
   * unconditionally regardless of its `integration` setting.
   *
   * `integration` says how the active PHONE transport reaches this
   * provider (bridge vs. native-to-Vapi); the playground has no
   * orchestrator of its own, so it always bridges — this is the one caller
   * that legitimately reaches past a `native` provider's adapter.
   *
   * @param {string} type - stt | llm | tts
   * @returns {Object} Adapter instance
   */
  getPlaygroundAdapter(type) {
    const name = this.config.active[type];
    const entry = this.config[type]?.[name];
    if (!entry) {
      throw new Error(
        `Unknown ${type} provider: "${name}". Available: ${Object.keys(this.config[type] || {}).join(', ')}`
      );
    }
    const AdapterClass = BRIDGE_ADAPTERS[type][name];
    if (!AdapterClass) {
      throw new Error(
        `${type}.${name} has no bridge adapter registered — the playground cannot use it.`
      );
    }
    return new AdapterClass();
  }

  /** @returns {Object} The active TTS adapter, bridged for the playground. */
  getActivePlaygroundTTS() {
    return this.getPlaygroundAdapter('tts');
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
