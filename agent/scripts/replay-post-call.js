'use strict';
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const crypto = require('crypto');

/**
 * Replay a real conversation through POST /el/post-call, exactly as ElevenLabs
 * would deliver it.
 *
 * Every part of the production path runs: the envelope, the HMAC signature, the
 * raw-body capture, the mapping, CONVERSATION_ENDED, outcome derivation and the
 * write. The only thing that does not happen is the phone call — the transcript
 * is fetched from a call that already happened.
 *
 * This exists because one path could not otherwise be tested. deriveOutcome's
 * tier 2 reads `data_collection_results`, which ElevenLabs produces only at the
 * end of a real call, so simulate-conversation cannot exercise it at all.
 * `--strip-tools` removes the tool calls from a real payload, which reproduces
 * the exact failure the backstop exists for: an agent that ended a call without
 * reporting an outcome.
 *
 *   node scripts/replay-post-call.js --conversation=conv_xxx
 *   node scripts/replay-post-call.js --conversation=conv_xxx --strip-tools
 *   node scripts/replay-post-call.js --conversation=conv_xxx --to=http://localhost:3001
 */

const API = 'https://api.elevenlabs.io';

function parseArgs(argv) {
  const out = { conversation: '', to: 'http://localhost:3001', 'strip-tools': false };
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/** The signature ElevenLabs sends: t=<unix>,v0=<hex over `${t}.${body}`>. */
function sign(rawBody, secret) {
  const t = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v0=${digest}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.conversation) {
    throw new Error('Pass --conversation=conv_xxx (see the calls table, or the ElevenLabs dashboard)');
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const secret = process.env.ELEVENLABS_POST_CALL_SECRET;
  if (!apiKey) throw new Error('Missing env var: ELEVENLABS_API_KEY');
  if (!secret) {
    throw new Error(
      'Missing env var: ELEVENLABS_POST_CALL_SECRET — the wsec_ value from the ' +
        'workspace webhook. Without it the route cannot verify the signature and ' +
        'will answer 401, which is what it is supposed to do.'
    );
  }

  const res = await fetch(`${API}/v1/convai/conversations/${args.conversation}`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`could not fetch conversation (${res.status}): ${await res.text()}`);
  const conversation = await res.json();

  let toolCallsRemoved = 0;
  if (args['strip-tools']) {
    for (const turn of conversation.transcript || []) {
      toolCallsRemoved += (turn.tool_calls || []).length;
      turn.tool_calls = [];
      turn.tool_results = [];
    }
  }

  // The envelope the webhook actually posts. The bare conversation object is
  // what GET returns; assuming the two were the same shape is what made every
  // real delivery 400 before this was fixed.
  const body = JSON.stringify({
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: conversation,
  });

  const extracted = conversation.analysis?.data_collection_results?.dose_outcome;
  console.log(`conversation      ${args.conversation}`);
  console.log(`transcript turns  ${(conversation.transcript || []).length}`);
  console.log(`tool calls        ${args['strip-tools'] ? `STRIPPED (${toolCallsRemoved})` : 'left in place'}`);
  console.log(`extracted outcome ${extracted ? extracted.value : '(none — agent has no data_collection field, or the call predates it)'}`);
  console.log('');

  const target = `${String(args.to).replace(/\/$/, '')}/el/post-call`;
  const delivery = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ElevenLabs-Signature': sign(body, secret),
    },
    body,
  });

  console.log(`POST ${target} -> ${delivery.status} ${await delivery.text()}`);
  if (delivery.status === 401) {
    console.log('\n401 means the signature did not verify. Check that');
    console.log('ELEVENLABS_POST_CALL_SECRET here matches the workspace webhook.');
  }
  console.log('\nWhat landed is in the calls table:');
  console.log(`  sqlite3 "$KINVOX_DB" "SELECT outcome_label, outcome_source, outcome_reason FROM calls WHERE call_id='${args.conversation}'"`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
