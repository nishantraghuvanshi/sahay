'use strict';
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const { SCENARIOS } = require('./lib/el-scenarios');

/**
 * Drive the real ElevenLabs agent through scripted conversations, without
 * ringing anyone or spending call minutes.
 *
 *   npm run simulate-elevenlabs                      # the baseline happy path
 *   npm run simulate-elevenlabs -- --scenario maybe  # one named scenario
 *   npm run simulate-elevenlabs -- --all             # the whole battery
 *
 * WHAT THIS PROVES
 *   - The agent's prompt is a working ElevenLabs template: given
 *     dynamic_variables it speaks the caller's real name and real medicine
 *     rather than the use-case config's demo defaults. That regression is why
 *     the first live call sounded vague — it was an agent given the wrong
 *     facts, not a bad prompt. A surviving `{{placeholder}}` fails the run.
 *   - Which outcome the agent selects, in Hindi, across the happy path, both
 *     escalation paths, conversation breakdowns, and adversarial probes.
 *
 * WHAT THIS DOES NOT PROVE
 *   Tool calls in a simulation are MOCKED by ElevenLabs (tool_mock_config,
 *   default return value "Tool Called."). Nothing here reaches
 *   POST /el/tools/:name, the tunnel, the auth header or the engine. The
 *   design doc's plan to "discover the webhook request/response shape
 *   empirically via simulate-conversation" cannot work for that reason.
 *
 *   It also measures nothing about latency. Turns are generated server-side as
 *   fast as the model runs and are never spoken, so nothing here reflects what
 *   a human would hear on a phone line.
 *
 * So: a prompt-and-decision check, not an end-to-end check. Treating a green
 * run as proof that outcomes persist would repeat the mistake this branch has
 * already made five times.
 */

const API = 'https://api.elevenlabs.io';

const DEFAULTS = {
  parent_name: 'कमला',
  drug_name: 'Metformin',
  caregiver_name: 'प्रिया',
  // Normally computed from the patient's medication rows by
  // scheduling/call-variables.js. Passed explicitly here so the battery
  // exercises the branches that depend on them; set either to '' to check the
  // silent path.
  next_call_line: 'मैं आपको रात के खाने के बाद, 9 बजे फिर कॉल करूँगी।',
  food_question: 'क्या आपने खाना खा लिया है?',
  food_line: 'यह दवाई खाने के बाद लेनी होती है।',
  scenario: 'took',
  // A dose call that needs more than this has already gone wrong. The schema
  // default is 10000, which makes a run take minutes and then die inside
  // undici's 300s headersTimeout as a bare "fetch failed".
  turns: 14,
  timeout_ms: 180000,
  concurrency: 4,
  out: '',
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, all: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const key = flag.replace(/^--/, '');
    if (key === 'all' || key === 'quiet') {
      out[key] = true;
      continue;
    }
    if (!(key in DEFAULTS)) continue;
    const raw = inline !== undefined ? inline : argv[++i];
    out[key] = typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
  }
  return out;
}

async function runScenario(key, scenario, args, credentials) {
  const dynamicVariables = {
    parent_name: args.parent_name,
    drug_name: args.drug_name,
    caregiver_name: args.caregiver_name,
    next_call_line: args.next_call_line,
    food_question: args.food_question,
    food_line: args.food_line,
    // A scenario may override any of these — the empty-variable paths are
    // behaviour in their own right and need testing, not just the filled ones.
    ...(scenario.variables || {}),
    // The correlation id createCall mints, so a simulated tool call carries
    // the same parameter a real one would.
    kinvox_call_id: `sim-${key}`,
  };

  const res = await fetch(
    `${API}/v1/convai/agents/${credentials.agentId}/simulate-conversation`,
    {
      method: 'POST',
      headers: { 'xi-api-key': credentials.key, 'Content-Type': 'application/json' },
      // undici otherwise gives up at 300s with a bare "fetch failed" — no
      // status, no body — which reads like a network fault rather than a
      // request that asked for too much.
      signal: AbortSignal.timeout(args.timeout_ms),
      body: JSON.stringify({
        new_turns_limit: args.turns,
        simulation_specification: {
          // A sibling of simulated_user_config, INSIDE simulation_specification.
          // Established by probing the live endpoint against the OpenAPI spec
          // after three plausible placements were each rejected with "Missing
          // required dynamic variables in first message": the request root,
          // simulated_user_config.dynamic_variables (that one configures the
          // simulated HUMAN, not the agent), and a
          // conversation_initiation_client_data block borrowed from the
          // outbound-call endpoint. The request root is what the prose docs imply.
          dynamic_variables: dynamicVariables,
          simulated_user_config: {
            first_message: scenario.first_message,
            language: 'hi',
            prompt: { prompt: scenario.prompt },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return { key, scenario, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const body = await res.json();
  const turns = body.simulated_conversation || [];

  const toolCalls = [];
  const leaked = new Set();
  const agentSpeech = [];
  // Simulated turns carry the same conversation_turn_metrics a real call does,
  // so LLM time-to-first-sentence is measurable here without ringing anyone.
  // That is the only latency figure this harness can honestly report: ASR
  // endpointing and TTS never run, so silence-to-first-audio cannot be.
  const llmMs = [];
  let reasonedTurns = 0;
  for (const turn of turns) {
    if (turn.role === 'agent') {
      if (turn.reasoned) reasonedTurns += 1;
      const metrics = turn.conversation_turn_metrics?.metrics || {};
      const ttf = metrics.convai_llm_service_ttf_sentence?.elapsed_time;
      if (ttf) llmMs.push(ttf * 1000);
    }
    if (turn.message) {
      if (turn.role === 'agent') agentSpeech.push(turn.message);
      for (const m of turn.message.match(/{{[a-zA-Z0-9_]+}}/g) || []) leaked.add(m);
    }
    for (const call of turn.tool_calls || []) toolCalls.push(call);
  }

  const outcomes = [];
  for (const call of toolCalls) {
    if (call.tool_name !== 'report_outcome') continue;
    try {
      outcomes.push(JSON.parse(call.params_as_json || '{}'));
    } catch {
      outcomes.push({ outcome: '(unparseable)', reason: call.params_as_json });
    }
  }

  const spoken = agentSpeech.join(' ');
  const problems = [];
  const warnings = [];

  if (leaked.size) problems.push(`spoke unfilled placeholders: ${[...leaked].join(', ')}`);

  // Square-bracket expressive tags ([happy], [sad], [slow]) appear all over
  // simulated transcripts and in NONE of the three real calls — checked
  // directly. eleven_v3_conversational runs with expressive_mode on, and a
  // real call's TTS consumes the tag as delivery instead of speaking it;
  // a simulation has no TTS, so the tag survives into the text.
  //
  // A warning, not a failure. Suppressing them via the prompt was tried and
  // both failed (the model does not control them) and would have thrown away
  // the expressiveness. Worth watching only in case one ever reaches a real
  // transcript, which would mean it was spoken aloud.
  const tags = [...new Set(spoken.match(/\[[a-zA-Z_ ]{2,20}\]/g) || [])];
  if (tags.length) warnings.push(`expressive tags in text: ${tags.join(', ')} (simulation-only)`);

  // Did the template actually receive the per-call facts? Only the two the
  // opener always speaks are asserted; caregiver_name legitimately may not come
  // up unless the call escalates.
  for (const name of ['parent_name', 'drug_name']) {
    if (!spoken.includes(dynamicVariables[name])) {
      problems.push(`never said ${name} ("${dynamicVariables[name]}")`);
    }
  }

  for (const guard of scenario.mustNotSay || []) {
    if (guard.pattern.test(spoken)) problems.push(`guardrail: ${guard.why}`);
  }

  // The inverse check. Recording the right outcome is not the same as making
  // a call worth answering: v7 scored 100/100 from ElevenLabs' own evaluator
  // while filing DENIED and hanging up without ever reminding the patient to
  // take the dose. An outcome-only assertion cannot see that.
  for (const guard of scenario.mustSay || []) {
    if (!guard.pattern.test(spoken)) problems.push(`omission: ${guard.why}`);
  }

  // Mirror the engine's derivation so the verdict reflects what would really
  // be persisted. checkToolCalls used to return the FIRST report_outcome; it
  // now lets an escalation anywhere in the call override, with the medical
  // emergency outranking distress. Judging on `first` here would disagree with
  // production for exactly the calls that matter most.
  const chain = outcomes.map((o) => o.outcome);
  const derived =
    chain.find((o) => o === 'ESCALATED_SYMPTOM') ||
    chain.find((o) => o === 'ESCALATED_DISTRESS') ||
    chain[0];
  const first = chain[0];
  const last = chain[chain.length - 1];

  // A stuck agent repeats itself until the turn cap: minutes of call time, no
  // outcome, and a caller who cannot get off the phone. Only visible by
  // looking at the speech, since every individual turn is well-formed.
  const repeated = new Map();
  for (const line of agentSpeech) {
    const norm = line.replace(/\s+/g, ' ').trim();
    // The simulator emits its own end-of-call token on BOTH roles once the
    // conversation is over. Counting it as agent speech reported a stuck loop
    // for calls that had in fact ended cleanly.
    if (/END_CALL/.test(norm)) continue;
    repeated.set(norm, (repeated.get(norm) || 0) + 1);
  }
  const stuck = [...repeated.entries()].filter(([, n]) => n >= 3);
  if (stuck.length) {
    problems.push(
      `stuck loop: repeated the same line ${stuck[0][1]}x ("${stuck[0][0].slice(0, 40)}…")`
    );
  }

  if (!outcomes.length) {
    problems.push('report_outcome never fired');
  } else {
    if (scenario.expect?.length && !scenario.expect.includes(derived)) {
      problems.push(`derived ${derived}, expected one of ${scenario.expect.join('/')}`);
    }
    if (scenario.forbid?.includes(derived)) {
      problems.push(`derived ${derived} is forbidden here`);
    }
    if (outcomes.length > 1) {
      // tools.json says "Call this EXACTLY ONCE per call". It does not comply.
      warnings.push(`report_outcome fired ${outcomes.length}x: ${chain.join(' -> ')}`);
      if (derived !== last) {
        warnings.push(`engine persists ${derived}; the call ended at ${last}`);
      }
    }
    if (outcomes[0].kinvox_call_id !== dynamicVariables.kinvox_call_id) {
      // A warning, not a failure: kinvox_call_id is declared with
      // `dynamic_variable`, which ElevenLabs resolves when it really executes
      // a tool. Simulated tool calls are mocked, so the injection plausibly
      // never runs, and the model would not invent the value — it carries no
      // description by design. Only a real call can settle this.
      warnings.push('kinvox_call_id absent (expected under mocking; verify on a real call)');
    }
  }

  return {
    key,
    label: scenario.label,
    note: scenario.note,
    turns,
    turnCount: turns.length,
    outcomes,
    llmMs,
    reasonedTurns,
    chain,
    derived,
    first,
    last,
    problems,
    warnings,
    passed: problems.length === 0,
  };
}

/** Bounded-concurrency map. A rejected scenario becomes a result, not a throw. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = {
          key: items[i][0],
          label: items[i][1].label,
          error: `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`,
        };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function printTranscript(result) {
  console.log(`\n──────── ${result.key} — ${result.label}`);
  if (result.error) {
    console.log(`  ERROR ${result.error}`);
    return;
  }
  for (const turn of result.turns) {
    if (turn.message) console.log(`  ${turn.role}: ${turn.message}`);
    for (const call of turn.tool_calls || []) {
      console.log(`  >> TOOL ${call.tool_name} ${call.params_as_json || '{}'}`);
    }
  }
  for (const w of result.warnings || []) console.log(`  warn: ${w}`);
  for (const p of result.problems || []) console.log(`  FAIL: ${p}`);
}

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key) throw new Error('Missing env var: ELEVENLABS_API_KEY');
  if (!agentId) {
    throw new Error('Missing env var: ELEVENLABS_AGENT_ID — run `npm run setup-elevenlabs`');
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !SCENARIOS[args.scenario]) {
    throw new Error(
      `Unknown --scenario ${args.scenario}.\nOptions: ${Object.keys(SCENARIOS).join(', ')}`
    );
  }
  const selected = args.all
    ? Object.entries(SCENARIOS)
    : [[args.scenario, SCENARIOS[args.scenario]]];

  console.log(`agent      ${agentId}`);
  console.log(
    `variables  parent=${args.parent_name} drug=${args.drug_name} caregiver=${args.caregiver_name}`
  );
  console.log(`turn cap   ${args.turns} (schema default is 10000)`);
  console.log(
    `scenarios  ${selected.length}${args.all ? ` at concurrency ${args.concurrency}` : ''}`
  );
  console.log('note       tool calls are MOCKED — nothing reaches our webhook or the engine\n');

  const started = Date.now();
  const results = await pool(selected, args.all ? args.concurrency : 1, ([k, s]) =>
    runScenario(k, s, args, { key, agentId })
  );
  const elapsed = (Date.now() - started) / 1000;

  if (!args.quiet) for (const r of results) printTranscript(r);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`${'scenario'.padEnd(19)}${'turns'.padStart(5)}  ${'outcome chain'.padEnd(38)} verdict`);
  console.log('-'.repeat(80));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.key.padEnd(19)}${'—'.padStart(5)}  ${'ERROR'.padEnd(38)} ${r.error.slice(0, 30)}`);
      continue;
    }
    const chain = r.outcomes.length ? r.chain.join('→') : '(none)';
    const verdict = r.passed ? (r.warnings.length ? 'pass (warn)' : 'pass') : 'FAIL';
    console.log(
      `${r.key.padEnd(19)}${String(r.turnCount).padStart(5)}  ${chain.slice(0, 38).padEnd(38)} ${verdict}`
    );
  }
  console.log('-'.repeat(80));

  // Latency, pooled across every scenario in the run.
  const allLlm = results.flatMap((r) => r.llmMs || []).sort((a, b) => a - b);
  const reasoned = results.reduce((n, r) => n + (r.reasonedTurns || 0), 0);
  if (allLlm.length) {
    const at = (q) => allLlm[Math.min(Math.floor(allLlm.length * q), allLlm.length - 1)];
    console.log(
      `llm ttf(ms)  n=${allLlm.length}  min=${allLlm[0].toFixed(0)}  ` +
        `median=${at(0.5).toFixed(0)}  p90=${at(0.9).toFixed(0)}  max=${allLlm[allLlm.length - 1].toFixed(0)}` +
        `  reasoned turns=${reasoned}`
    );
    if (reasoned > 0) {
      // thinking_budget: 0 in providers.yaml should make this zero. Reasoning
      // costs a caller time on every turn, and a v6 transcript shows it being
      // spoken aloud to a patient when it leaks.
      console.log(`             ${reasoned} turn(s) reasoned — check transport.elevenlabs.thinking_budget`);
    }
  }

  const failed = results.filter((r) => r.error || !r.passed);
  const warned = results.filter((r) => !r.error && r.passed && r.warnings.length);
  console.log(
    `${results.length - failed.length}/${results.length} passed` +
      `${warned.length ? `, ${warned.length} with warnings` : ''} in ${elapsed.toFixed(1)}s`
  );

  if (failed.length) {
    console.log('\nFailures:');
    for (const r of failed) {
      console.log(`  ${r.key}: ${(r.error ? [r.error] : r.problems).join('; ')}`);
    }
  }
  if (warned.length) {
    console.log('\nWarnings:');
    for (const r of warned) console.log(`  ${r.key}: ${r.warnings.join('; ')}`);
  }

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(results, null, 2));
    console.log(`\ntranscripts written to ${args.out}`);
  }

  // The battery is an exploration harness — several scenarios are recorded
  // rather than asserted, so a non-zero exit would be noise. A single named
  // scenario keeps a real exit code so it can gate something.
  if (!args.all && failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  if (e.cause) console.error(`cause: ${e.cause.code || ''} ${e.cause.message || e.cause}`);
  process.exit(1);
});
