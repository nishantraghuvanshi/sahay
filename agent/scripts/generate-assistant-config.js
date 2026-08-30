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

/**
 * The value written into every secret-bearing field of the COMMITTED config.
 *
 * config/assistant.json is tracked and this repo becomes public. The generated
 * config legitimately carries VAPI_SECRET in four places (assistant server,
 * transcriber URL query, custom-LLM header, TTS server) because that is how
 * Vapi is told the secret — but a tracked file must never hold the live value.
 *
 * Compounding it: tests/assistant-config-staleness.test.js asserts the
 * committed file matches a fresh generation, so without redaction the test
 * would actively pressure a real secret into the repo to stay green.
 *
 * So the on-disk artifact is redacted and update-assistant.js PATCHes from the
 * in-memory config, which still carries the real secret.
 */
const REDACTED_SECRET = '__FROM_ENV_VAPI_SECRET__';

/**
 * Return a deep copy with every occurrence of the live secret replaced.
 * Substring-based rather than key-based, because the secret also appears
 * inside the transcriber's ws URL as an api_key query parameter.
 */
function redactSecrets(config, secret = process.env.VAPI_SECRET) {
  if (!secret) return config;
  const json = JSON.stringify(config).split(secret).join(REDACTED_SECRET);
  return JSON.parse(json);
}

/**
 * The value written into every WEBHOOK_URL-derived field of the COMMITTED
 * config.
 *
 * webhookUrl comes from each developer's own .env (a tunnel origin during
 * the sprint, e.g. https://voice.voxikin.com) — it is not a shared constant
 * like the rest of the generated config. A committed file that bakes in
 * whoever last ran the generator's URL fails tests/assistant-config-staleness.test.js
 * for every OTHER developer, because the test compares the committed file
 * against what the generator produces from the reader's own .env. Redacting
 * it to a placeholder makes the committed artifact environment-free, so the
 * staleness test is deterministic for everyone.
 */
const WEBHOOK_URL_PLACEHOLDER = '${WEBHOOK_URL}';

/**
 * VapiTransportAdapter#buildAssistantConfig (src/adapters/transport/vapi.js)
 * embeds webhookUrl in two textual forms: the URL as given, and an
 * http(s)->ws(s) transform of it for the transcriber's WebSocket server URL
 * (`webhookUrl.replace(/^http/, 'ws')`). A single placeholder can't stand in
 * for both — restoring it would need to guess which field originally held
 * which form — so the ws(s) form gets its own placeholder.
 */
const WEBHOOK_URL_WS_PLACEHOLDER = '${WEBHOOK_URL_WS}';

function wsForm(webhookUrl) {
  return webhookUrl.replace(/^http/, 'ws');
}

/**
 * Return a deep copy with every occurrence of the real webhook URL — in
 * either textual form it appears in — replaced by its placeholder.
 * Substring-based, like redactSecrets, because the webhook URL is embedded
 * inside several full URLs (the transcriber's wss URL, the custom-LLM URL,
 * the TTS server URL, the top-level webhook URL) rather than living in one
 * field. The ws(s) form is redacted first since it's a superset-ish
 * transform of the same host — redacting the http(s) form first would
 * leave a dangling "ws" + placeholder fragment behind.
 */
function redactWebhookUrl(config, webhookUrl) {
  if (!webhookUrl) return config;
  const json = JSON.stringify(config)
    .split(wsForm(webhookUrl)).join(WEBHOOK_URL_WS_PLACEHOLDER)
    .split(webhookUrl).join(WEBHOOK_URL_PLACEHOLDER);
  return JSON.parse(json);
}

/**
 * Reverse of redactWebhookUrl — substitutes a real webhook URL back in for
 * both placeholders, restoring each to the textual form it stood in for.
 * Exists so the placeholder scheme is verifiably reversible (substitution
 * reproduces the original concrete output) for any consumer that reads
 * config/assistant.json directly rather than calling generate(). Neither
 * create-assistant.js nor update-assistant.js needs this today — both
 * rebuild the config fresh from generate(), which already carries the real
 * webhookUrl in memory — but a future consumer of the committed file will.
 */
function substituteWebhookUrl(config, webhookUrl) {
  const json = JSON.stringify(config)
    .split(WEBHOOK_URL_WS_PLACEHOLDER).join(wsForm(webhookUrl))
    .split(WEBHOOK_URL_PLACEHOLDER).join(webhookUrl);
  return JSON.parse(json);
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
  // Redacted: the committed artifact must never carry the live secret or
  // any one developer's webhook URL.
  const redacted = redactWebhookUrl(redactSecrets(assistantConfig), webhookUrl);
  fs.writeFileSync(outputPath, JSON.stringify(redacted, null, 2) + '\n');

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

module.exports = {
  generate,
  redactSecrets,
  REDACTED_SECRET,
  redactWebhookUrl,
  substituteWebhookUrl,
  WEBHOOK_URL_PLACEHOLDER,
  WEBHOOK_URL_WS_PLACEHOLDER,
};
