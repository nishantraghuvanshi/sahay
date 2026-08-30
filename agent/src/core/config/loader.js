'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PROVIDER_TYPES = ['stt', 'llm', 'tts'];

/**
 * How a provider is wired in on the phone path.
 *
 *   bridge — audio/tokens flow through this server, so an adapter must exist
 *            in src/adapters/providers/** and a route is served for it.
 *   native — the phone transport (Vapi, etc.) talks to the provider
 *            directly; we only name it in the assistant config, no route.
 *
 * This describes the PHONE transport's relationship to the provider, not
 * every consumer's — the playground has no orchestrator of its own and
 * always bridges its active providers, so a `native` provider may still
 * have an adapter registered for the playground to use (see
 * ProviderRegistry.getPlaygroundAdapter). These are two different
 * architectures, not two providers, which is why the distinction is
 * declared rather than inferred.
 */
const INTEGRATIONS = ['bridge', 'native'];

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../../../config/providers.yaml');

/**
 * Validate a providers config object.
 *
 * Pure — takes an object, throws on the first problem, returns it otherwise.
 * Deliberately knows nothing about which adapters exist: core/ must never
 * import from adapters/. Adapter-backing is enforced by ProviderRegistry.
 *
 * @param {Object} config - Parsed providers config
 * @returns {Object} The same config, when valid
 * @throws {Error} With a message naming the exact offending key
 */
function validateProvidersConfig(config) {
  if (!config || !config.active) {
    throw new Error('providers.yaml: missing "active" section');
  }

  if (!config.active.transport) {
    throw new Error('providers.yaml: missing active.transport');
  }
  if (!config.transport || !config.transport[config.active.transport]) {
    throw new Error(
      `providers.yaml: active.transport="${config.active.transport}" but no config under transport.${config.active.transport}`
    );
  }

  for (const type of PROVIDER_TYPES) {
    const activeName = config.active[type];
    if (!activeName) {
      throw new Error(`providers.yaml: missing active.${type}`);
    }
    if (!config[type] || !config[type][activeName]) {
      throw new Error(
        `providers.yaml: active.${type}="${activeName}" but no config under ${type}.${activeName}`
      );
    }

    // Every declared provider, not just the active one — a config entry that
    // cannot be selected is worse than one that is absent.
    for (const [name, entry] of Object.entries(config[type])) {
      if (!entry.integration) {
        throw new Error(
          `providers.yaml: ${type}.${name} is missing "integration" (one of ${INTEGRATIONS.join('|')})`
        );
      }
      if (!INTEGRATIONS.includes(entry.integration)) {
        throw new Error(
          `providers.yaml: ${type}.${name}.integration="${entry.integration}" is not one of ${INTEGRATIONS.join('|')}`
        );
      }
    }
  }

  return config;
}

/**
 * Load and validate platform configuration.
 *
 * Reads providers.yaml from the config/ directory.
 * Use-case prompts are loaded by the strategy, not here.
 *
 * @param {string} [configPath] - Override the config file location (tests)
 * @returns {Object} Parsed providers config
 */
function loadProvidersConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(raw);

  // A test that needs a specific orchestrator should be able to say so
  // without editing a shared config file, and an operator should be able to
  // A/B the two transports without a YAML edit between runs. TRANSPORT wins
  // over active.transport when set; it is validated the same way the YAML
  // value is, so an unknown TRANSPORT fails at boot with the same clear
  // message an unknown YAML value would.
  if (process.env.TRANSPORT && config && config.active) {
    config.active.transport = process.env.TRANSPORT;
  }

  return validateProvidersConfig(config);
}

module.exports = {
  loadProvidersConfig,
  validateProvidersConfig,
  INTEGRATIONS,
  PROVIDER_TYPES,
};
