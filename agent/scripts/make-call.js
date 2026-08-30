'use strict';

/**
 * Make Outbound Call
 *
 * Triggers an outbound call through whichever orchestrator active.transport
 * selects in config/providers.yaml. The agent calls the specified phone number
 * and runs the medication adherence conversation flow.
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
 *   --slot      Dose slot this call is about, "HH:MM". Defaults to the most
 *               recent slot in the patient's schedule at the current time.
 *   --caregiver Caregiver name spoken in the escalation line
 *               (default: DEFAULT_CAREGIVER_NAME from .env)
 *
 * Prerequisites depend on active.transport:
 *   vapi        VAPI_ASSISTANT_ID (from create-assistant.js), VAPI_PRIVATE_KEY
 *   elevenlabs  ELEVENLABS_AGENT_ID (from `npm run setup-elevenlabs`),
 *               ELEVENLABS_API_KEY, and transport.elevenlabs.phone_number_id
 */

const path = require('path');
require('dotenv').config();
// The repo-root .env carries ELEVENLABS_API_KEY, exactly as server.js loads it.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');
const ProviderRegistry = require('../src/adapters/providers/registry');
const {
  buildScheduleVariables,
} = require('../src/use-cases/medication-adherence/scheduling/call-variables');
const { utcToLocalParts } = require('../src/utils/time');
const TransportRegistry = require('../src/adapters/transport/registry');

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

  // Go through the registry rather than constructing a Vapi adapter directly.
  // Hardcoding Vapi here meant this script ignored active.transport entirely,
  // so it could not place a call through whichever orchestrator the product
  // was actually configured to use.
  const transportRegistry = new TransportRegistry(new ProviderRegistry());
  const transport = transportRegistry.getActiveTransport();

  let assistantId;
  try {
    assistantId = transport.getAssistantId();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const variables = {
    parent_name: args.name || process.env.DEFAULT_PARENT_NAME || 'रोहन',
    drug_name: args.drug || process.env.DEFAULT_DRUG_NAME || 'Crocin',
    // Templated into the escalation reassurance line. Left out, it is spoken
    // as a literal "{{caregiver_name}}" or rejected outright by ElevenLabs.
    caregiver_name: args.caregiver || process.env.DEFAULT_CAREGIVER_NAME || 'आपके परिवार',
    language: args.language || 'hi',
  };

  console.log('Initiating outbound call...');
  console.log(`  Phone: ${phone}`);
  console.log(`  Parent: ${variables.parent_name}`);
  console.log(`  Drug: ${variables.drug_name}`);
  console.log(`  Caregiver: ${variables.caregiver_name}`);
  console.log(`  Language: ${variables.language}`);
  console.log(`  Assistant ID: ${assistantId}`);
  console.log('');

  const repository = buildRepository();
  transport.repository = repository;

  // Same schedule lookup the /api/call route does, so a call placed by hand
  // carries the same context a scheduled one would.
  Object.assign(
    variables,
    await buildScheduleVariables({
      repository,
      phone,
      slot: args.slot,
      nowHHMM: utcToLocalParts(new Date().toISOString(), 'Asia/Kolkata').hhmm,
    })
  );
  if (variables.next_call_line) console.log(`  Next call: ${variables.next_call_line}`);
  if (variables.food_line) console.log(`  Food: ${variables.food_line}`);

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
