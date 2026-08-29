'use strict';

/**
 * Update Vapi Assistant
 *
 * Re-generates the assistant config from config files and updates the
 * existing Vapi assistant via PATCH. Use this after changing prompts.yaml
 * or providers.yaml to push changes to the live Vapi assistant.
 *
 * Usage:
 *   node scripts/update-assistant.js
 *
 * Prerequisites:
 *   - VAPI_ASSISTANT_ID set in .env (from create-assistant.js)
 *   - VAPI_PRIVATE_KEY set in .env
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const vapiClient = require('./lib/vapi-client');
const { generate } = require('./generate-assistant-config');

async function main() {
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  if (!assistantId) {
    console.error('Error: VAPI_ASSISTANT_ID not set in .env');
    console.error('Run `node scripts/create-assistant.js` first to create an assistant.');
    process.exit(1);
  }

  // 1. Re-generate the config from config files
  const { assistantConfig, strategy, providersConfig } = generate();

  // 2. Also write the updated config to disk
  const configPath = path.join(__dirname, '..', 'config', 'assistant.json');
  fs.writeFileSync(configPath, JSON.stringify(assistantConfig, null, 2) + '\n');

  console.log('Updating Vapi assistant...');
  console.log(`  ID: ${assistantId}`);
  console.log(`  Name: ${assistantConfig.name}`);
  console.log(`  Use case: ${strategy.name}`);
  console.log(`  Prompt version: ${strategy.getPromptVersion()}`);
  console.log(`  Transcriber: ${assistantConfig.transcriber.provider}`);
  console.log(`  Model: ${assistantConfig.model.provider}`);
  console.log(`  Voice: ${assistantConfig.voice.provider}`);
  console.log('');

  // 3. Update the assistant via Vapi API
  const updated = await vapiClient.updateAssistant(assistantId, assistantConfig);

  console.log('Assistant updated successfully!');
  console.log(`  ID: ${updated.id}`);
  console.log(`  Updated at: ${updated.updatedAt || 'N/A'}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
