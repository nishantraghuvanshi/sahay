'use strict';

/**
 * Make Outbound Call
 *
 * Triggers an outbound call via Vapi. The agent calls the specified phone
 * number and runs the medication adherence conversation flow.
 *
 * Usage:
 *   node scripts/make-call.js --phone=+91XXXXXXXXXX --name=रोहन --drug=Crocin
 *   node scripts/make-call.js --phone=+91XXXXXXXXXX --name=रोहन --drug=Crocin --language=hi
 *   node scripts/make-call.js --phone=+91XXXXXXXXXX  # uses defaults from .env
 *
 * Arguments:
 *   --phone   E.164 phone number (required, e.g., +91XXXXXXXXXX)
 *   --name    Parent's name (default: DEFAULT_PARENT_NAME from .env)
 *   --drug    Medication name (default: DEFAULT_DRUG_NAME from .env)
 *   --language  Language code: hi or en (default: hi)
 *
 * Prerequisites:
 *   - VAPI_ASSISTANT_ID set in .env (from create-assistant.js)
 *   - VAPI_PRIVATE_KEY set in .env
 */

require('dotenv').config();

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');

/**
 * Same repository selection as server.js: SQLite when DB_PATH/DATABASE_URL
 * is set, otherwise a no-op console repository. Without this, the call went
 * out through vapi-client.js directly, bypassing the transport adapter's
 * createCall — so no session was ever opened, and a dropped dose reminder
 * placed via this script could never be resumed.
 */
function buildRepository() {
  const dbPath = process.env.DB_PATH || process.env.DATABASE_URL;
  return dbPath ? new SqliteRepository({ dbPath }) : new ConsoleRepository();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs();

  const phone = args.phone;
  if (!phone) {
    console.error('Error: --phone is required');
    console.error('Usage: node scripts/make-call.js --phone=+91XXXXXXXXXX --name=रोहन --drug=Crocin');
    process.exit(1);
  }

  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!assistantId) {
    console.error('Error: VAPI_ASSISTANT_ID not set in .env');
    console.error('Run `node scripts/create-assistant.js` first.');
    process.exit(1);
  }

  const variables = {
    parent_name: args.name || process.env.DEFAULT_PARENT_NAME || 'रोहन',
    drug_name: args.drug || process.env.DEFAULT_DRUG_NAME || 'Crocin',
    language: args.language || 'hi',
  };

  console.log('Initiating outbound call...');
  console.log(`  Phone: ${phone}`);
  console.log(`  Parent: ${variables.parent_name}`);
  console.log(`  Drug: ${variables.drug_name}`);
  console.log(`  Language: ${variables.language}`);
  console.log(`  Assistant ID: ${assistantId}`);
  console.log('');

  const repository = buildRepository();
  const transport = new VapiTransportAdapter(null);
  transport.repository = repository;

  let call;
  try {
    // Routed through the transport adapter (not vapi-client.js) so this
    // dispatch opens a session exactly like the /api/call route does.
    call = await transport.createCall(assistantId, phone, variables);
  } finally {
    if (typeof repository.close === 'function') await repository.close();
  }

  console.log('Call initiated!');
  console.log(`  Call ID: ${call.id}`);
  console.log(`  Status: ${call.status || 'queued'}`);
  console.log('');
  console.log('The agent will call the number shortly.');
  console.log('Call outcomes are logged to the bridge server console (webhook /webhook).');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
