'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { chooseDestination, buildRoutingMessages, parseDestination, STAY } = require('../src/core/squad/router');

/**
 * The router decides when a call changes state. Two failure directions, and
 * they are not symmetric:
 *
 *  - Moving too early strands a patient mid-answer and is immediately audible.
 *  - Failing to move leaves the agent on the previous goal, which is recoverable
 *    because the next turn routes again.
 *
 * So every ambiguous case must resolve to STAY, and these assert that rather
 * than trusting the prompt to discourage it.
 */

const MEMBER = {
  key: 'dose_check',
  label: 'Dose Check',
  destinations: [
    { to: 'wellbeing', description: 'The patient has confirmed they took the dose.' },
    { to: 'stay_on_line', description: 'The patient says they will take it right now.' },
    { to: 'refusal', description: 'The patient does not want to take the dose.' },
  ],
};

const PREFIX_MEMBER = {
  key: 'meal_check',
  destinations: [
    { to: 'dose_check_after', description: 'The patient has eaten.' },
    { to: 'callback_meal', description: 'The patient has not eaten yet.' },
  ],
};

describe('parsing a routing reply', () => {
  test('reads a plain destination name', () => {
    assert.strictEqual(parseDestination('wellbeing', MEMBER), 'wellbeing');
    assert.strictEqual(parseDestination('  refusal\n', MEMBER), 'refusal');
  });

  test('reads a destination the model wrapped in noise', () => {
    assert.strictEqual(parseDestination('Answer: stay_on_line.', MEMBER), 'stay_on_line');
  });

  test('treats STAY as staying', () => {
    assert.strictEqual(parseDestination('STAY', MEMBER), STAY);
    assert.strictEqual(parseDestination('stay', MEMBER), STAY);
  });

  test('treats anything unrecognised as staying, never a guess', () => {
    for (const reply of ['', null, undefined, 'I think we should move on', 'close', '3', '???']) {
      assert.strictEqual(
        parseDestination(reply, MEMBER),
        STAY,
        `"${reply}" should stay rather than jump to an arbitrary state`
      );
    }
  });

  test('a shared prefix does not swallow the longer key', () => {
    // `dose_check` is a real member elsewhere in the graph and is a prefix of
    // `dose_check_after`. A substring match would route to the wrong state.
    assert.strictEqual(parseDestination('dose_check_after', PREFIX_MEMBER), 'dose_check_after');
    assert.strictEqual(parseDestination('callback_meal', PREFIX_MEMBER), 'callback_meal');
  });
});

describe('the routing prompt', () => {
  test('offers STAY explicitly as an option', () => {
    // A classifier handed a list will pick from the list. Without an explicit
    // stay option the call races through every state in a handful of turns.
    const messages = buildRoutingMessages(MEMBER, []);
    assert.ok(/STAY/.test(messages[0].content), 'STAY must be an offered choice');
    assert.ok(/most of the time/i.test(messages[0].content), 'STAY must be framed as the common answer');
  });

  test('lists every destination with its condition', () => {
    const content = buildRoutingMessages(MEMBER, []).content || buildRoutingMessages(MEMBER, [])[0].content;
    for (const d of MEMBER.destinations) {
      assert.ok(content.includes(d.to), `${d.to} missing from the routing prompt`);
      assert.ok(content.includes(d.description), `${d.to}'s condition missing`);
    }
  });

  test('passes recent turns, not the whole call', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    const transcript = buildRoutingMessages(MEMBER, many)[1].content;
    assert.ok(transcript.includes('turn 19'), 'the most recent turn must be present');
    assert.ok(!transcript.includes('turn 3'), 'old turns should not be re-sent every routing call');
  });

  test('handles a call with no turns yet', () => {
    assert.ok(buildRoutingMessages(MEMBER, [])[1].content.length > 0);
  });
});

describe('choosing a destination', () => {
  const cfg = {};
  const env = {};

  test('returns the model’s choice', async () => {
    const llmAdapter = { chatCompletion: async () => ({ content: 'wellbeing' }) };
    assert.strictEqual(
      await chooseDestination({ llmAdapter, llmConfig: cfg, env, member: MEMBER, messages: [] }),
      'wellbeing'
    );
  });

  test('stays when the member has nowhere to go', async () => {
    let called = false;
    const llmAdapter = { chatCompletion: async () => { called = true; return { content: 'wellbeing' }; } };
    const terminal = { key: 'close', destinations: [] };
    assert.strictEqual(
      await chooseDestination({ llmAdapter, llmConfig: cfg, env, member: terminal, messages: [] }),
      STAY
    );
    assert.strictEqual(called, false, 'a terminal member should not cost a routing call');
  });

  test('a routing failure stays put instead of ending the call', async () => {
    // A live call must survive a router outage. Staying is the same outcome as
    // a router that cannot decide, and the next turn routes again.
    const llmAdapter = { chatCompletion: async () => { throw new Error('router upstream down'); } };
    const logged = [];
    const result = await chooseDestination({
      llmAdapter, llmConfig: cfg, env, member: MEMBER, messages: [],
      logger: { log() {}, error: (e) => logged.push(e) },
    });
    assert.strictEqual(result, STAY);
    assert.strictEqual(logged.length, 1, 'the failure must be visible, not silent');
  });

  test('logs every routing decision so a dead condition is findable', async () => {
    const llmAdapter = { chatCompletion: async () => ({ content: 'STAY' }) };
    const lines = [];
    await chooseDestination({
      llmAdapter, llmConfig: cfg, env, member: MEMBER, messages: [],
      logger: { log: (e, d) => lines.push([e, d]), error() {} },
    });
    assert.strictEqual(lines[0][0], 'squad_route');
    assert.strictEqual(lines[0][1].from, 'dose_check');
    assert.strictEqual(lines[0][1].to, 'STAY');
  });
});
