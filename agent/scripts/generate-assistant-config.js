'use strict';

/**
 * Generate Vapi Assistant Config
 *
 * Reads providers.yaml, prompts.yaml, and use-case config,
 * then uses the VapiTransportAdapter.buildAssistantConfig()
 * method to produce the Vapi assistant JSON.
 *
 * This is the single source of truth for the Vapi assistant config —
 * it's generated from the same config files that the bridge server uses,
 * so the phone agent and the playground always use the same prompts and providers.
 *
 * Usage:
 *   node scripts/generate-assistant-config.js [--output config/assistant.json]
 *
 * Output:
 *   Writes the generated config to config/assistant.json (or --output path)
 *   Prints a summary to stdout
 */

const fs = require('fs');
const path = require('path');

// Load environment (for WEBHOOK_URL)
require('dotenv').config();

// Core
const { loadProvidersConfig } = require('../src/core/config/loader');

// Adapters
const ProviderRegistry = require('../src/adapters/providers/registry');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');

// Use cases
const { getActiveUseCase } = require('../src/use-cases/registry');

function generate() {
  // 1. Load configs
  const providersConfig = loadProvidersConfig();
  const useCase = getActiveUseCase();

  // 2. Instantiate strategy
  const strategy = new useCase.strategy();

  // 3. Create provider registry (for adapter access)
  const providerRegistry = new ProviderRegistry();

  // 4. Create transport adapter (for buildAssistantConfig)
  const transport = new VapiTransportAdapter(providerRegistry);

  // 5. Determine webhook URL
  const webhookUrl = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3001}`;

  // 6. Build assistant config
  const assistantConfig = transport.buildAssistantConfig(strategy, providersConfig, webhookUrl);

  return { assistantConfig, strategy, providersConfig, webhookUrl };
}

function main() {
  const args = process.argv.slice(2);
  let outputPath = path.join(__dirname, '..', 'config', 'assistant.json');

  // Parse --output flag
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputPath = path.resolve(args[outputIdx + 1]);
  }

  const { assistantConfig, strategy, providersConfig, webhookUrl } = generate();

  // Write config file
  fs.writeFileSync(outputPath, JSON.stringify(assistantConfig, null, 2) + '\n');

  // Print summary
  console.log(JSON.stringify({
    event: 'assistant_config_generated',
    output: outputPath,
    name: assistantConfig.name,
    firstMessage: assistantConfig.firstMessage,
    transcriber: assistantConfig.transcriber.provider,
    model: assistantConfig.model.provider,
    voice: assistantConfig.voice.provider,
    tools: (assistantConfig.model.tools || []).map(t => t.type === 'function' ? t.function.name : t.type),
    silenceTimeout: assistantConfig.silenceTimeoutSeconds,
    maxDuration: assistantConfig.maxDurationSeconds,
    webhookUrl,
    useCase: strategy.name,
    promptVersion: strategy.getPromptVersion(),
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { generate };
