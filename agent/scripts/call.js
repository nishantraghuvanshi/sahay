'use strict';
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const readline = require('readline');
const ProviderRegistry = require('../src/adapters/providers/registry');
const TransportRegistry = require('../src/adapters/transport/registry');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');
const {
  buildScheduleVariables,
} = require('../src/use-cases/medication-adherence/scheduling/call-variables');
const { utcToLocalParts } = require('../src/utils/time');

/**
 * Place one real dose call, and show what happened.
 *
 *   npm run call -- +918104348262 निशांत Metformin
 *   npm run call -- --phone +918104348262 --name निशांत --drug Metformin
 *   npm run call -- --phone=+918104348262 --name=निशांत --drug=Metformin
 *
 * A PHONE RINGS. It asks before dialling; pass --yes to skip that.
 *
 * This exists because make-call.js dials and stops there, so every check —
 * is the tunnel current, what will it actually say, what did the caller reply,
 * what got recorded — had to be done by hand afterwards. All of it is here.
 *
 * Preflight matters more than it looks. The failure this catches is silent: if
 * WEBHOOK_URL no longer matches the live ngrok tunnel, the call still connects
 * and the agent still talks, but every tool call lands on a dead host, so
 * nothing is recorded and the transcript looks fine.
 */

const AGENT_URL = process.env.AGENT_BASE_URL || 'http://localhost:3001';
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';

function parseArgs(argv) {
  const out = { yes: false, wait: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [flag, inline] = arg.split(/=(.*)/s);
    const key = flag.replace(/^--/, '');
    if (key === 'yes' || key === 'y') {
      out.yes = true;
    } else if (key === 'no-wait') {
      out.wait = false;
    } else {
      // Accept `--key value` as well as `--key=value`. make-call.js takes only
      // the second, which is a quiet way to end up calling with a default name.
      out[key] = inline !== undefined ? inline : argv[++i];
    }
  }
  // Positional, in the order you would say them out loud.
  if (!out.phone && positional[0]) out.phone = positional[0];
  if (!out.name && positional[1]) out.name = positional[1];
  if (!out.drug && positional[2]) out.drug = positional[2];
  return out;
}

function usage(problem) {
  console.error(`\n${problem}\n`);
  console.error('  npm run call -- <phone> <name> <medicine>');
  console.error('  npm run call -- +918104348262 निशांत Metformin\n');
  console.error('Options:');
  console.error('  --caregiver <name>  spoken in the escalation line');
  console.error('  --slot HH:MM        which dose this call is about (default: from the clock)');
  console.error('  --yes               skip the confirmation');
  console.error('  --no-wait           dial and exit, without showing the transcript\n');
  process.exit(1);
}

function buildRepository() {
  const dbPath =
    process.env.DB_PATH || process.env.DATABASE_URL || process.env.KINVOX_DB;
  return dbPath ? new SqliteRepository({ dbPath }) : new ConsoleRepository();
}

/** The live tunnel, or null when ngrok is not running locally. */
async function liveTunnel() {
  try {
    const res = await fetch(NGROK_API, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    const https = (body.tunnels || []).find((t) => t.public_url?.startsWith('https://'));
    return https ? https.public_url : null;
  } catch {
    return null;
  }
}

async function preflight() {
  const problems = [];

  for (const key of ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID']) {
    if (!process.env[key]) problems.push(`${key} is not set`);
  }

  let serverUp = false;
  try {
    const res = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(3000) });
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    problems.push(`the agent is not answering at ${AGENT_URL} — run \`npm start\` in agent/`);
  }

  // The silent one. A stale WEBHOOK_URL still produces a call that connects and
  // sounds correct, while every tool call goes to a host that no longer exists.
  const tunnel = await liveTunnel();
  const configured = process.env.WEBHOOK_URL;
  if (tunnel && configured && tunnel !== configured) {
    problems.push(
      `WEBHOOK_URL is stale.\n` +
        `      agent/.env says : ${configured}\n` +
        `      ngrok is now on : ${tunnel}\n` +
        `      Update agent/.env and restart the agent, or tool calls will go nowhere.`
    );
  }
  if (!configured) problems.push('WEBHOOK_URL is not set in agent/.env');

  return problems;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

const API = 'https://api.elevenlabs.io';

async function fetchConversation(id) {
  const res = await fetch(`${API}/v1/convai/conversations/${id}`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function printTranscript(conversation) {
  const meta = conversation.metadata || {};
  console.log('');
  console.log('─'.repeat(66));
  console.log(
    `${meta.call_duration_secs}s · ${meta.cost} credits · ended: ${meta.termination_reason}`
  );
  console.log('─'.repeat(66));

  const waits = [];
  const llm = [];
  for (const turn of conversation.transcript || []) {
    const metrics = turn.conversation_turn_metrics?.metrics || {};
    const wait = metrics.convai_ttf_audio_since_silence?.elapsed_time;
    const think = metrics.convai_llm_service_ttf_sentence?.elapsed_time;
    if (wait && turn.time_in_call_secs > 0) waits.push(wait * 1000);
    if (think) llm.push(think * 1000);

    if (turn.message) {
      const who = turn.role === 'agent' ? 'agent' : ' you ';
      const tag = wait ? `  (${(wait * 1000).toFixed(0)}ms)` : '';
      console.log(`${who} │ ${turn.message}${tag}`);
    }
    for (const call of turn.tool_calls || []) {
      let args = {};
      try {
        args = JSON.parse(call.params_as_json || '{}');
      } catch {
        /* shown raw below */
      }
      if (call.tool_name === 'report_outcome') {
        console.log(`      └─ recorded ${args.outcome}${args.reason ? ` — ${args.reason}` : ''}`);
      } else if (call.tool_name === 'end_call') {
        console.log('      └─ hung up');
      } else {
        console.log(`      └─ ${call.tool_name}`);
      }
    }
  }

  console.log('─'.repeat(66));
  const w = median(waits);
  const l = median(llm);
  if (w) console.log(`wait before replying: ${w.toFixed(0)}ms median · model ${l ? l.toFixed(0) : '—'}ms`);

  const analysis = conversation.analysis || {};
  const extracted = analysis.data_collection_results?.dose_outcome?.value;
  if (extracted) console.log(`ElevenLabs read the call as: ${extracted}`);

  // Expressive tags belong in the delivery, not the words. One reached a real
  // call on 30 Aug, so it is worth seeing when it happens again.
  const spoken = (conversation.transcript || [])
    .filter((t) => t.role === 'agent' && t.message)
    .map((t) => t.message)
    .join(' ');
  const tags = [...new Set(spoken.match(/\[[a-zA-Z_ ]{2,20}\]/g) || [])];
  if (tags.length) console.log(`⚠ spoke a bracket tag aloud: ${tags.join(', ')}`);
}

async function printRecord(repository, conversationId) {
  if (!repository.db) return;
  const row = repository.db
    .prepare(
      'SELECT outcome_label, outcome_source, outcome_reason, prompt_version ' +
        'FROM calls WHERE call_id = ?'
    )
    .get(conversationId);
  console.log('');
  if (!row) {
    console.log('Nothing recorded yet. The post-call webhook may still be in flight —');
    console.log('re-run in a moment, or check the agent log for el_post_call_processed.');
    return;
  }
  console.log(
    `Recorded: ${row.outcome_label} (${row.outcome_source}) · prompt v${row.prompt_version}` +
      `${row.outcome_reason ? `\n  reason: ${row.outcome_reason}` : ''}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.phone) usage('Which number should I call?');
  if (!args.phone.startsWith('+')) {
    usage(`Phone must be E.164 — "+91…" not "${args.phone}". Include the country code.`);
  }
  if (!args.name) usage('Who am I calling? Pass the name the agent should use.');
  if (!args.drug) usage('Which medicine is this call about?');

  const problems = await preflight();
  if (problems.length) {
    console.error('\nNot dialling. Fix these first:\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    process.exit(1);
  }

  const repository = buildRepository();
  const schedule = await buildScheduleVariables({
    repository,
    phone: args.phone,
    slot: args.slot,
    nowHHMM: utcToLocalParts(new Date().toISOString(), 'Asia/Kolkata').hhmm,
  });

  const variables = {
    parent_name: args.name,
    drug_name: args.drug,
    caregiver_name: args.caregiver || 'आपके परिवार',
    language: 'hi',
    ...schedule,
  };

  console.log('');
  console.log(`  Calling    ${args.phone}`);
  console.log(`  As         ${variables.parent_name}, about ${variables.drug_name}`);
  console.log(`  Caregiver  ${variables.caregiver_name}`);
  // Shown before dialling, because these are the sentences the agent will
  // actually say and an empty one is usually a missing schedule, not a bug.
  console.log(`  Food line  ${schedule.food_line || '(none — no food rule on file)'}`);
  console.log(`  Next call  ${schedule.next_call_line || '(none — no later dose today)'}`);
  console.log('');

  if (!args.yes) {
    if (!process.stdin.isTTY) {
      console.error('Not a terminal, so I cannot ask. Re-run with --yes if you mean it.');
      process.exit(1);
    }
    const answer = await ask(`  This will ring ${args.phone} for real. Continue? [y/N] `);
    if (answer !== 'y' && answer !== 'yes') {
      console.log('  Cancelled. Nothing was dialled.');
      process.exit(0);
    }
  }

  const transport = new TransportRegistry(new ProviderRegistry()).getActiveTransport();
  transport.repository = repository;

  let call;
  try {
    call = await transport.createCall(transport.getAssistantId(), args.phone, variables);
  } catch (err) {
    console.error(`\n  Could not place the call: ${err.message}\n`);
    process.exit(1);
  }

  const conversationId = call.conversation_id || call.id;
  console.log(`  Ringing… (${conversationId})`);

  if (!args.wait) {
    console.log('');
    if (typeof repository.close === 'function') await repository.close();
    return;
  }

  // Poll rather than guess a duration: a call runs as long as it runs, and the
  // 180s cap is the real ceiling.
  const deadline = Date.now() + 240000;
  let conversation = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    conversation = await fetchConversation(conversationId);
    if (conversation && conversation.status === 'done') break;
    process.stdout.write('.');
  }
  console.log('');

  if (!conversation || conversation.status !== 'done') {
    console.log('\n  Still running after four minutes. Fetch it later with:');
    console.log(`    npm run replay-post-call -- --conversation=${conversationId}\n`);
  } else {
    printTranscript(conversation);
    // The outcome is written by the post-call webhook, which lands a moment
    // after the conversation is marked done.
    await new Promise((r) => setTimeout(r, 3000));
    await printRecord(repository, conversationId);
  }

  console.log('');
  if (typeof repository.close === 'function') await repository.close();
}

main().catch((e) => {
  console.error(e.message);
  if (e.cause) console.error(`cause: ${e.cause.code || ''} ${e.cause.message || e.cause}`);
  process.exit(1);
});
