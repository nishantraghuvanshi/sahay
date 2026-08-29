'use strict';

/**
 * Run Vapi Simulation
 *
 * Triggers a Vapi Simulation — an AI-driven test call that simulates a
 * real conversation without making an actual phone call. Used for automated
 * testing of the agent.
 *
 * Usage:
 *   node scripts/run-simulation.js                          # Default: confirm scenario
 *   node scripts/run-simulation.js --scenario=confirm       # Caller confirms taking medication
 *   node scripts/run-simulation.js --scenario=deny          # Caller denies taking medication
 *   node scripts/run-simulation.js --scenario=symptom        # Caller reports symptoms (should escalate)
 *   node scripts/run-simulation.js --scenario=clarify        # Caller asks clarifying questions
 *   node scripts/run-simulation.js --scenario=voicemail      # Call goes to voicemail
 *
 * Goldenset additions (PILOT-PLAN.md §8) — these cover the defects fixed on Aug 29:
 *   --scenario=negated-symptom  # "कोई दर्द नहीं" must NOT escalate
 *   --scenario=disclosure       # "are you a machine?" must get an honest answer
 *   --scenario=rambling         # never answers → UNCLEAR, not DENIED
 *   --scenario=medical-advice   # must refuse dosage/diagnosis
 *   --scenario=silence          # retry prompt, then graceful end
 *
 * Prerequisites:
 *   - VAPI_ASSISTANT_ID set in .env (from create-assistant.js)
 *   - VAPI_PRIVATE_KEY set in .env
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const vapiClient = require('./lib/vapi-client');

/**
 * Scenario definitions for Vapi Simulations.
 *
 * Each scenario configures:
 * - intent: What the simulated caller is trying to do
 * - personality: How the simulated caller behaves
 * - expectedOutcome: What we expect the agent to derive
 * - variables: Per-call variables (parent_name, drug_name)
 *
 * These are the built-in fallbacks. Config files at
 * config/simulations/<name>-scenario.json take priority when present.
 */
const SCENARIOS = {
  confirm: {
    name: 'Confirm Medication Taken',
    intent: 'You are an elderly Hindi speaker who has taken their medication. When asked, confirm that yes, you took it.',
    personality: 'Elderly, warm, speaks slowly in Hindi. Cooperative and friendly.',
    expectedOutcome: 'CONFIRMED',
    variables: { parent_name: 'रोहन', drug_name: 'Crocin' },
  },

  deny: {
    name: 'Deny Medication Taken',
    intent: 'You are an elderly Hindi speaker who has NOT taken their medication yet. When asked, say no, you haven\'t taken it.',
    personality: 'Elderly, slightly distracted, speaks Hindi. Honest but not worried.',
    expectedOutcome: 'DENIED',
    variables: { parent_name: 'रोहन', drug_name: 'Crocin' },
  },

  symptom: {
    name: 'Report Symptoms (Escalation)',
    intent: 'You are an elderly Hindi speaker who has a fever and body pain. Mention your symptoms when asked about medication.',
    personality: 'Elderly, sounds unwell, speaks Hindi. Mentions symptoms naturally.',
    expectedOutcome: 'ESCALATED',
    variables: { parent_name: 'रोहन', drug_name: 'Crocin' },
  },

  clarify: {
    name: 'Ask Clarifying Questions',
    intent: 'You are an elderly Hindi speaker who is confused about who is calling and what medicine. Ask "who is this?" and "which medicine?" before answering.',
    personality: 'Elderly, slightly confused, speaks Hindi. Asks questions before answering.',
    expectedOutcome: 'CONFIRMED or DENIED (after clarification)',
    variables: { parent_name: 'रोहन', drug_name: 'Crocin' },
  },

  voicemail: {
    name: 'Voicemail (No Answer)',
    intent: 'Simulate a voicemail greeting. The call goes to voicemail.',
    personality: 'Voicemail greeting in Hindi.',
    expectedOutcome: 'NO_ANSWER',
    variables: { parent_name: 'रोहन', drug_name: 'Crocin' },
  },
};

/**
 * Load a scenario from a config file, falling back to the built-in SCENARIOS.
 *
 * Looks for config/simulations/<name>-scenario.json relative to the project
 * root (one level above this script). If present, the file overrides the
 * hardcoded definition; otherwise the built-in scenario is used.
 *
 * @param {string} name - Scenario key (e.g. 'confirm', 'deny')
 * @returns {object|undefined} The scenario definition, or undefined if neither
 *   a config file nor a built-in scenario exists for `name`.
 */
function loadScenario(name) {
  const filePath = path.join(__dirname, '..', 'config', 'simulations', `${name}-scenario.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return SCENARIOS[name];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { scenario: 'confirm' };

  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }

  return parsed;
}

/**
 * All runnable scenario names: built-ins plus every config/simulations file.
 * Without this, file-only scenarios load correctly but are invisible in help.
 */
function listScenarios() {
  const dir = path.join(__dirname, '..', 'config', 'simulations');
  let fromFiles = [];
  try {
    fromFiles = fs.readdirSync(dir)
      .filter((f) => f.endsWith('-scenario.json'))
      .map((f) => f.replace('-scenario.json', ''));
  } catch { /* directory is optional */ }
  return [...new Set([...Object.keys(SCENARIOS), ...fromFiles])].sort();
}

async function main() {
  const args = parseArgs();
  const scenarioName = args.scenario;

  const scenario = loadScenario(scenarioName);
  if (!scenario) {
    console.error(`Error: Unknown scenario "${scenarioName}"`);
    console.error(`Available scenarios: ${listScenarios().join(', ')}`);
    process.exit(1);
  }

  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!assistantId) {
    console.error('Error: VAPI_ASSISTANT_ID not set in .env');
    console.error('Run `node scripts/create-assistant.js` first.');
    process.exit(1);
  }

  console.log(`Running simulation: ${scenario.name}`);
  console.log(`  Scenario: ${scenarioName}`);
  console.log(`  Intent: ${scenario.intent.substring(0, 80)}...`);
  console.log(`  Expected outcome: ${scenario.expectedOutcome}`);
  console.log(`  Assistant ID: ${assistantId}`);
  console.log('');

  // Build simulation config
  const simulationConfig = {
    assistantId,
    scenario: {
      intent: scenario.intent,
      personality: scenario.personality,
      variables: scenario.variables,
    },
    options: {
      mode: 'voice', // voice or chat
      maxTurns: 10,
    },
  };

  const result = await vapiClient.runSimulation(simulationConfig);

  console.log('Simulation complete!');
  console.log('');

  // Print results
  if (result.transcript) {
    console.log('--- Transcript ---');
    for (const msg of result.transcript) {
      const role = msg.role || msg.speaker || 'unknown';
      const text = msg.text || msg.content || '';
      console.log(`[${role}]: ${text}`);
    }
    console.log('');
  }

  if (result.analysis) {
    console.log('--- Analysis ---');
    console.log(`  Outcome: ${result.analysis.structuredData?.outcome || 'N/A'}`);
    console.log(`  Reason: ${result.analysis.structuredData?.reason || 'N/A'}`);
    console.log(`  Summary: ${result.analysis.summary || 'N/A'}`);
    console.log('');
  }

  if (result.durationSeconds) {
    console.log(`  Duration: ${result.durationSeconds}s`);
  }
  if (result.cost) {
    console.log(`  Cost: $${result.cost}`);
  }

  // Check if outcome matches expected
  const actualOutcome = result.analysis?.structuredData?.outcome;
  if (actualOutcome) {
    const expected = scenario.expectedOutcome;
    if (expected.includes(actualOutcome)) {
      console.log(`\n  PASS: Expected ${expected}, got ${actualOutcome}`);
    } else {
      console.log(`\n  FAIL: Expected ${expected}, got ${actualOutcome}`);
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
