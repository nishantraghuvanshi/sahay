'use strict';

/**
 * Ground Truth
 *
 * Records a human's judgement of what actually happened on a call
 * (calls.ground_truth), so an automated outcome can later be measured
 * against it. Nothing else populates this column.
 *
 * Usage:
 *   node scripts/ground-truth.js set <callId> <label> [reason...]
 *   node scripts/ground-truth.js list [--limit=N]
 *
 * `set` fails loudly (non-zero exit) on an unknown call id — it never
 * silently no-ops. `list` shows recent calls with their derived outcome
 * (outcome_label, computed automatically at call end) alongside the human
 * ground_truth, so a human can see at a glance which ones disagree.
 */

require('dotenv').config();

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');
const { resolveConfiguredDbPath } = require('../src/utils/db-path');

/**
 * Same repository selection as seed-medications.js / make-call.js /
 * server.js, minus VOXIKIN_DB — deliberately: this script only ever runs
 * against a path given explicitly for this invocation, never the shared
 * product database.
 */
function buildRepository() {
  const { value: dbPath, varName } = resolveConfiguredDbPath(['DB_PATH', 'DATABASE_URL']);
  return dbPath ? new SqliteRepository({ dbPath, dbPathSource: varName }) : new ConsoleRepository();
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      flags[match[1]] = match[2];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function runSet(repo, positional) {
  const [callId, ...rest] = positional;
  if (!callId || rest.length === 0) {
    console.error('Usage: node scripts/ground-truth.js set <callId> <label> [reason...]');
    process.exit(1);
  }
  const groundTruth = rest.join(' ');

  // Fails loudly (throws) on an unknown call id — see setGroundTruth's doc
  // comment. Let that propagate to main()'s catch rather than swallowing it
  // here.
  const call = await repo.setGroundTruth(callId, groundTruth);
  console.log(`Set ground truth for ${callId}:`);
  console.log(`  outcome_label: ${call.outcome_label || '(none)'}`);
  console.log(`  ground_truth:  ${call.ground_truth}`);
}

async function runList(repo, flags) {
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
  const calls = await repo.list({ limit });

  if (calls.length === 0) {
    console.log('No calls found.');
    return;
  }

  console.log(
    ['call_id', 'created_at', 'outcome_label', 'ground_truth', 'status'].join('\t')
  );
  for (const call of calls) {
    console.log(
      [
        call.call_id,
        call.created_at || '',
        call.outcome_label || '(none)',
        call.ground_truth || '(none)',
        _status(call),
      ].join('\t')
    );
  }
}

/**
 * Distinguishes an unlabelled call from one where the derived outcome and
 * the human ground truth agree or disagree — the whole point of this
 * listing.
 * @private
 */
function _status(call) {
  if (!call.ground_truth) return 'UNLABELLED';
  if (!call.outcome_label) return 'NO_DERIVED_OUTCOME';
  return call.outcome_label === call.ground_truth ? 'AGREE' : 'DISAGREE';
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const repo = buildRepository();

  try {
    if (command === 'set') {
      await runSet(repo, positional);
    } else if (command === 'list') {
      await runList(repo, flags);
    } else {
      console.error('Usage:');
      console.error('  node scripts/ground-truth.js set <callId> <label> [reason...]');
      console.error('  node scripts/ground-truth.js list [--limit=N]');
      process.exit(1);
    }
  } finally {
    if (typeof repo.close === 'function') await repo.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { buildRepository, parseArgs, runSet, runList, _status };
