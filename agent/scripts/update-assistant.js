'use strict';

/**
 * Update Vapi Assistant
 *
 * Re-generates the assistant config from config files and updates the
 * existing Vapi assistant via PATCH. Use this after changing
 * config/use-cases/*.yaml or providers.yaml to push changes to the live
 * Vapi assistant.
 *
 * VAPI_ASSISTANT_ID already points at the live assistant that answers real
 * phone calls, so a PATCH here is not a local change — it's a production
 * deploy. To make that hard to do by accident, this defaults to a DRY RUN:
 * it generates the config, prints a summary of what would change, and
 * exits without touching Vapi or the committed config file. Pass --yes (or
 * --confirm) to actually apply it.
 *
 * Usage:
 *   node scripts/update-assistant.js            # dry run — prints the diff, PATCHes nothing
 *   node scripts/update-assistant.js --yes       # applies it: writes config/assistant.json, PATCHes Vapi
 *
 * Prerequisites:
 *   - VAPI_ASSISTANT_ID set in .env (from create-assistant.js)
 *   - VAPI_PRIVATE_KEY set in .env
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const defaultVapiClient = require('./lib/vapi-client');
const { generate } = require('./generate-assistant-config');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'assistant.json');

/**
 * Read the committed assistant config, if any, to diff the newly generated
 * one against it. Returns null rather than throwing on a first run.
 * @returns {Object|null}
 */
function readCommittedConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Recursively collect the dotted paths whose values differ between two
 * plain-object configs, so a reviewer can see what a PATCH would actually
 * change without eyeballing the full JSON.
 * @param {*} before
 * @param {*} after
 * @param {string} [prefix]
 * @returns {string[]}
 */
function diffPaths(before, after, prefix = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      diffPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key)
    );
  }
  return [prefix || '(root)'];
}

/**
 * @param {string[]} [argv]
 * @param {Object} [deps] - Injectable for tests: { vapiClient }
 * @returns {Promise<Object>} { applied, assistantConfig, changedPaths }
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const vapiClient = deps.vapiClient || defaultVapiClient;
  const apply = argv.includes('--yes') || argv.includes('--confirm');

  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!assistantId) {
    console.error('Error: VAPI_ASSISTANT_ID not set in .env');
    console.error('Run `node scripts/create-assistant.js` first to create an assistant.');
    process.exit(1);
  }

  // 1. Re-generate the config from config files
  const { assistantConfig, strategy } = generate();
  const committed = readCommittedConfig();
  const changedPaths = diffPaths(committed || {}, assistantConfig);

  console.log(apply ? 'Updating Vapi assistant...' : 'DRY RUN — no changes will be sent to Vapi.');
  console.log(`  ID: ${assistantId}`);
  console.log(`  Name: ${assistantConfig.name}`);
  console.log(`  Use case: ${strategy.name}`);
  console.log(`  Prompt version: ${strategy.getPromptVersion()}`);
  console.log(`  Transcriber: ${assistantConfig.transcriber.provider}`);
  console.log(`  Model: ${assistantConfig.model.provider}`);
  console.log(`  Voice: ${assistantConfig.voice.provider}`);
  console.log('');

  if (changedPaths.length === 0) {
    console.log('  No differences from the committed config/assistant.json.');
  } else {
    console.log(`  ${changedPaths.length} field(s) would change vs. committed config/assistant.json:`);
    for (const p of changedPaths) {
      console.log(`    - ${p}`);
    }
  }
  console.log('');

  if (!apply) {
    console.log('This is a dry run. Re-run with --yes to PATCH the live assistant.');
    return { applied: false, assistantConfig, changedPaths };
  }

  // 2. Write the updated config to disk
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(assistantConfig, null, 2) + '\n');

  // 3. Update the assistant via Vapi API
  const updated = await vapiClient.updateAssistant(assistantId, assistantConfig);

  console.log('Assistant updated successfully!');
  console.log(`  ID: ${updated.id}`);
  console.log(`  Updated at: ${updated.updatedAt || 'N/A'}`);

  return { applied: true, assistantConfig, changedPaths };
}

module.exports = { main, diffPaths };

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
