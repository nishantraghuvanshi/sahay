'use strict';

const { buildScheduleVariables } = require('./scheduling/call-variables');
const { utcToLocalParts } = require('../../utils/time');

/**
 * A demo dose call: the real agent, the caregiver's real prescription, and
 * nobody's phone rings.
 *
 * This is `POST /v1/convai/agents/{id}/simulate-conversation` — the same
 * endpoint the scenario battery uses. ElevenLabs runs our actual agent against
 * a scripted patient and returns the conversation as text. No telephony, no
 * call minutes, and no audio: what comes back is a transcript, which is exactly
 * what a caregiver deciding whether to trust this thing wants to read.
 *
 * Two things it deliberately is NOT:
 *
 *   - It is not a rehearsal of the phone line. Turn-taking, speech recognition
 *     and text-to-speech never run, so it says nothing about how the call
 *     sounds or how long the pauses are. A caregiver should be told that.
 *   - It is not a test of the tool webhooks. Tool calls in a simulation are
 *     mocked by ElevenLabs, so `report_outcome` is shown as the agent's
 *     decision and never reaches the engine or the database. A demo call
 *     therefore cannot mark a dose taken, which is the property that makes it
 *     safe to hand to a caregiver.
 */

const API = 'https://api.elevenlabs.io';

/**
 * ElevenLabs' expressive tags — [slow], [sad], [happy] — survive into a
 * simulated transcript because no text-to-speech consumed them. They appear in
 * none of the real calls, checked directly against every one placed so far.
 * Stripping them is presentation, not censorship: on a real call the caregiver
 * would hear the delivery, not the word.
 */
function stripExpressiveTags(text) {
  return text.replace(/\[[a-zA-Z_ ]{2,20}\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Kept short: a caregiver is reading this, and a demo that runs twenty turns is
// a demo nobody finishes.
const DEFAULT_TURN_LIMIT = 12;
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * How the simulated patient behaves. Small on purpose — this is a preview for
 * a caregiver, not the 24-scenario battery in scripts/lib/el-scenarios.js.
 * Each one is a situation a caregiver will recognise from their own parent.
 */
const PERSONAS = {
  took: {
    label: 'Already taken it',
    first_message: 'हाँ बोलो',
    prompt:
      'You are the elderly parent being called. You HAVE already taken this ' +
      'dose, about twenty minutes ago. Answer briefly and warmly in Hindi, the ' +
      'way an elderly person actually speaks on the phone.',
  },
  forgot: {
    label: 'Forgot, and will take it',
    first_message: 'हाँ, कौन?',
    prompt:
      'You are the elderly parent being called. You have NOT taken this dose — ' +
      'you forgot. Say so when asked. Do not volunteer anything else; wait to ' +
      'be asked. If they ask you to take it now, agree. Answer briefly in Hindi.',
  },
  refuses: {
    label: 'Does not want to take it',
    first_message: 'हाँ बोलो',
    prompt:
      'You are the elderly parent being called. You have not taken this dose ' +
      'and you do not intend to. Say so plainly. You are not upset, just ' +
      'decided. If they ask WHY, say the tablet upsets your stomach. Answer ' +
      'briefly in Hindi.',
  },
  unwell: {
    label: 'Reports feeling unwell',
    first_message: 'हाँ...',
    prompt:
      'You are the elderly parent being called. You took the dose, but you now ' +
      'have a tight, heavy feeling in your chest and you are frightened. ' +
      'Mention it when asked how you are. Answer briefly in Hindi.',
  },
};

/**
 * Run one demo call.
 *
 * @param {Object} params
 * @param {Object} params.repository - for the caregiver's real dose schedule
 * @param {string} params.phone - the patient's number, used to find their schedule
 * @param {string} params.parentName
 * @param {string} params.drugName
 * @param {string} [params.caregiverName]
 * @param {string} [params.persona] - key of PERSONAS
 * @param {string} [params.agentId]
 * @param {string} [params.apiKey]
 * @returns {Promise<Object>} { persona, turns, outcome, variables, notes }
 */
async function runDemoCall({
  repository,
  phone,
  parentName,
  drugName,
  caregiverName,
  persona = 'forgot',
  agentId = process.env.ELEVENLABS_AGENT_ID,
  apiKey = process.env.ELEVENLABS_API_KEY,
  turnLimit = DEFAULT_TURN_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const chosen = PERSONAS[persona];
  if (!chosen) {
    const err = new Error(`Unknown persona "${persona}". Options: ${Object.keys(PERSONAS).join(', ')}`);
    err.code = 'unknown_persona';
    throw err;
  }
  if (!agentId || !apiKey) {
    const err = new Error('Demo calls need ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY');
    err.code = 'not_configured';
    throw err;
  }

  // The caregiver's actual schedule, so the demo speaks their parent's real
  // medicine and their real next dose time. An empty line means the same here
  // as on a real call: say nothing rather than invent something.
  const schedule = await buildScheduleVariables({
    repository,
    phone,
    nowHHMM: utcToLocalParts(new Date().toISOString(), 'Asia/Kolkata').hhmm,
  });

  const variables = {
    parent_name: parentName,
    drug_name: drugName,
    caregiver_name: caregiverName || 'आपके परिवार',
    kinvox_call_id: 'demo',
    ...schedule,
  };

  const res = await fetch(`${API}/v1/convai/agents/${agentId}/simulate-conversation`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      // Unset, this defaults to 10000 and the request runs for minutes before
      // the client gives up.
      new_turns_limit: turnLimit,
      simulation_specification: {
        // A sibling of simulated_user_config, not the request root.
        dynamic_variables: variables,
        simulated_user_config: {
          first_message: chosen.first_message,
          language: 'hi',
          prompt: { prompt: chosen.prompt },
        },
      },
    }),
  });

  if (!res.ok) {
    const err = new Error(`simulate-conversation failed (${res.status})`);
    err.code = 'upstream_failed';
    err.status = res.status;
    err.detail = (await res.text()).slice(0, 300);
    throw err;
  }

  const body = await res.json();
  const rawTurns = body.simulated_conversation || [];

  const turns = [];
  let outcome = null;
  for (const turn of rawTurns) {
    const message = stripExpressiveTags(turn.message || '');
    if (message) turns.push({ role: turn.role, message });
    for (const call of turn.tool_calls || []) {
      let args = {};
      try {
        args = JSON.parse(call.params_as_json || '{}');
      } catch {
        args = {};
      }
      if (call.tool_name === 'report_outcome' && args.outcome && !outcome) {
        outcome = { label: args.outcome, reason: args.reason || null };
      }
      turns.push({ role: 'tool', tool: call.tool_name, args });
    }
  }

  return {
    persona,
    persona_label: chosen.label,
    turns,
    outcome,
    variables: {
      parent_name: variables.parent_name,
      drug_name: variables.drug_name,
      next_call_line: variables.next_call_line,
      food_line: variables.food_line,
    },
    // Surfaced to the caller so the UI can say what this did and did not test,
    // rather than letting a caregiver read it as a rehearsal of the real call.
    notes: {
      no_audio: true,
      tools_mocked: true,
      nothing_recorded: true,
    },
  };
}

module.exports = { runDemoCall, PERSONAS };
