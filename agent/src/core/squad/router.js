'use strict';

/**
 * Decide which squad member should handle the next turn.
 *
 * On the phone, Vapi owns this: each `assistantDestination` carries a
 * `description` and Vapi matches it against the conversation. The playground
 * has no such machinery, so to exercise the same graph locally something has to
 * make the same decision — otherwise the playground would be testing a
 * single-prompt agent while the phone runs a state machine, and the one place
 * the design can be *heard* would be the one place it isn't running.
 *
 * This is an emulation, not a reimplementation. It will not match Vapi's
 * routing exactly, and it is not meant to: it exists so transition problems
 * (a condition that never fires, two conditions that both fire, a state you
 * can enter and not leave) surface before a real patient is on the line.
 *
 * Deliberately a separate, small model call rather than asking the member's own
 * prompt to emit a routing token. Mixing "talk to the patient" and "decide the
 * next state" into one completion is how you get the routing instruction spoken
 * aloud — a failure this project has already shipped once.
 */

/** Returned when the conversation should stay where it is. */
const STAY = null;

/**
 * Build the routing prompt for one decision.
 *
 * The model is given only the destination conditions and the recent turns, and
 * is asked for a single token. It is told explicitly that staying is allowed
 * and common — without that, a classifier asked to choose from a list will
 * choose from the list, and the call would race through every state in four
 * turns.
 *
 * @param {Object} member - the current member { key, label, destinations }
 * @param {Array<{role,content}>} recentTurns
 * @returns {Array<{role,content}>} messages for the routing call
 */
function buildRoutingMessages(member, recentTurns) {
  const options = member.destinations
    .map((d, i) => `${i + 1}. ${d.to} — ${d.description}`)
    .join('\n');

  const transcript = recentTurns
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'PATIENT' : 'AGENT'}: ${m.content}`)
    .join('\n');

  return [
    {
      role: 'system',
      content: [
        'You are a router in a phone conversation. You do not talk to anyone.',
        'Read the recent turns and decide whether the conversation should move to a',
        'different step, or stay where it is.',
        '',
        `Current step: ${member.key}`,
        '',
        'Available moves:',
        options,
        `${member.destinations.length + 1}. STAY — none of the above has happened yet`,
        '',
        'Answer with the step name only (for example: wellbeing) or the word STAY.',
        'No explanation, no punctuation.',
        '',
        'STAY is the correct answer most of the time. Only move when the condition has',
        'ACTUALLY happened in the turns above — not when it is merely being discussed,',
        'and not because a move seems due. Moving early strands the patient mid-answer.',
      ].join('\n'),
    },
    { role: 'user', content: transcript || '(no turns yet)' },
  ];
}

/**
 * Parse a routing reply into a destination key.
 *
 * Anything unrecognised means STAY. A router that guesses when it cannot read
 * its own output would move the call to an arbitrary state; staying is always
 * recoverable, because the next turn routes again.
 *
 * @param {string} reply
 * @param {Object} member
 * @returns {string|null}
 */
function parseDestination(reply, member) {
  const text = String(reply || '').trim().toLowerCase();
  if (!text) return STAY;

  // Destinations are matched FIRST. `stay_on_line` is a real member, so a
  // naive "does the reply contain 'stay'" check ahead of this would make that
  // state permanently unreachable — the agent could never wait on the line
  // while a patient fetched their tablets.
  for (const d of member.destinations) {
    // Whole-word so `dose_check` cannot swallow `dose_check_after`, which
    // shares its prefix.
    if (new RegExp(`(^|[^a-z_])${d.to}([^a-z_]|$)`).test(text)) return d.to;
  }

  return STAY;
}

/**
 * Choose the next member, or null to stay.
 *
 * Never throws: a routing failure must not end a live call. On any error the
 * conversation stays where it is, which is the same outcome as a router that
 * cannot decide, and is logged so a broken condition is visible rather than
 * silently degrading into a single-state agent.
 *
 * @param {Object} args
 * @param {Object} args.llmAdapter - any LLM port implementation
 * @param {Object} args.llmConfig
 * @param {Object} args.env
 * @param {Object} args.member - current member
 * @param {Array} args.messages - conversation history
 * @param {Object} [args.logger]
 * @returns {Promise<string|null>} destination key, or null to stay
 */
async function chooseDestination({ llmAdapter, llmConfig, env, member, messages, logger }) {
  if (!member || !member.destinations || member.destinations.length === 0) return STAY;

  try {
    const result = await llmAdapter.chatCompletion(
      { messages: buildRoutingMessages(member, messages), max_tokens: 12 },
      llmConfig,
      env
    );
    const reply = (result && (result.content ?? result.text ?? '')) || '';
    const next = parseDestination(reply, member);
    if (logger) {
      logger.log('squad_route', { from: member.key, to: next || 'STAY', reply: String(reply).slice(0, 40) });
    }
    return next;
  } catch (err) {
    if (logger) logger.error('squad_route_failed', err);
    return STAY;
  }
}

module.exports = { chooseDestination, buildRoutingMessages, parseDestination, STAY };
