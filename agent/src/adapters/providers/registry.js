'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Adapter implementations
const SarvamSTTAdapter = require('./stt/sarvam');
const SarvamLLMAdapter = require('./llm/sarvam');
const GroqLLMAdapter = require('./llm/groq');
const SarvamTTSAdapter = require('./tts/sarvam');

// Provider name → adapter class mapping
const STT_ADAPTERS = { sarvam: SarvamSTTAdapter };
const LLM_ADAPTERS = { sarvam: SarvamLLMAdapter, groq: GroqLLMAdapter };
const TTS_ADAPTERS = { sarvam: SarvamTTSAdapter };

/**
 * Provider Registry
 *
 * Reads providers.yaml and instantiates the active STT/LLM/TTS adapters.
 * This is the bridge between config-driven provider selection and
 * the hexagonal port/adapter architecture.
 */
class ProviderRegistry {
  constructor() {
    this.config = this._loadConfig();
    this.env = process.env;
  }

  _loadConfig() {
    const configPath = path.join(__dirname, '../../../config/providers.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    return yaml.load(raw);
  }

  getActiveSTT() {
    const name = this.config.active.stt;
    const AdapterClass = STT_ADAPTERS[name];
    if (!AdapterClass) {
      throw new Error(`Unknown STT provider: "${name}". Available: ${Object.keys(STT_ADAPTERS).join(', ')}`);
    }
    return new AdapterClass();
  }

  getActiveLLM() {
    const name = this.config.active.llm;
    const AdapterClass = LLM_ADAPTERS[name];
    if (!AdapterClass) {
      throw new Error(`Unknown LLM provider: "${name}". Available: ${Object.keys(LLM_ADAPTERS).join(', ')}`);
    }
    return new AdapterClass();
  }

  getActiveTTS() {
    const name = this.config.active.tts;
    const AdapterClass = TTS_ADAPTERS[name];
    if (!AdapterClass) {
      throw new Error(`Unknown TTS provider: "${name}". Available: ${Object.keys(TTS_ADAPTERS).join(', ')}`);
    }
    return new AdapterClass();
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
