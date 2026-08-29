'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Load and validate platform configuration.
 *
 * Reads providers.yaml from the config/ directory.
 * Use-case prompts are loaded by the strategy, not here.
 *
 * @returns {Object} Parsed providers config
 */
function loadProvidersConfig() {
  const configPath = path.join(__dirname, '../../../config/providers.yaml');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(raw);

  // Validate
  if (!config.active) {
    throw new Error('providers.yaml: missing "active" section');
  }
  for (const type of ['stt', 'llm', 'tts']) {
    if (!config.active[type]) {
      throw new Error(`providers.yaml: missing active.${type}`);
    }
    if (!config[type] || !config[type][config.active[type]]) {
      throw new Error(
        `providers.yaml: active.${type}="${config.active[type]}" but no config under ${type}.${config.active[type]}`
      );
    }
  }

  return config;
}

module.exports = { loadProvidersConfig };
