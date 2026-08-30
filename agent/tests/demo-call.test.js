'use strict';
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');

const { runDemoCall, PERSONAS } = require('../src/use-cases/medication-adherence/demo-call');

const REPO = {
  async findPatientByPhone() {
    return { id: 'p1', meal_times: '{"dinner": "19:30"}' };
  },
  async findMedicationsForPatient() {
    return [{ slots: '["08:00", "20:00"]', with_food: 'after' }];
  },
};

/** One simulate-conversation response, shaped like the real one. */
function elevenLabsReplies(payload, { ok = true, status = 200 } = {}) {
  return mock.method(globalThis, 'fetch', async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
}

const SIMPLE = {
  simulated_conversation: [
    { role: 'agent', message: 'नमस्ते, क्या आपने ले लिया है?' },
    { role: 'user', message: 'नहीं, भूल गयी।' },
    {
      role: 'agent',
      message: 'कोई बात नहीं।',
      tool_calls: [
        { tool_name: 'report_outcome', params_as_json: '{"outcome":"DENIED","reason":"forgot"}' },
      ],
    },
  ],
};

describe('runDemoCall', () => {
  test('returns the conversation as ordered turns a caregiver can read', async (t) => {
    const f = elevenLabsReplies(SIMPLE);
    t.after(() => f.mock.restore());
    const out = await runDemoCall({
      repository: REPO, phone: '+91', parentName: 'कमला', drugName: 'Metformin',
      agentId: 'agent_x', apiKey: 'key_x',
    });
    assert.deepStrictEqual(
      out.turns.map((x) => x.role),
      ['agent', 'user', 'agent', 'tool']
    );
    assert.strictEqual(out.turns[0].message, 'नमस्ते, क्या आपने ले लिया है?');
  });

  test('surfaces the outcome the agent decided on', async (t) => {
    const f = elevenLabsReplies(SIMPLE);
    t.after(() => f.mock.restore());
    const out = await runDemoCall({
      repository: REPO, phone: '+91', parentName: 'क', drugName: 'M',
      agentId: 'a', apiKey: 'k',
    });
    assert.deepStrictEqual(out.outcome, { label: 'DENIED', reason: 'forgot' });
  });

  test('speaks the caregiver own schedule, not a fixture', async (t) => {
    let sent;
    const f = mock.method(globalThis, 'fetch', async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => SIMPLE, text: async () => '' };
    });
    t.after(() => f.mock.restore());
    const out = await runDemoCall({
      repository: REPO, phone: '+91', parentName: 'कमला', drugName: 'Metformin',
      agentId: 'a', apiKey: 'k',
    });
    const vars = sent.simulation_specification.dynamic_variables;
    assert.strictEqual(vars.parent_name, 'कमला');
    assert.strictEqual(vars.drug_name, 'Metformin');
    // 20:00 dose, dinner at 19:30 — the real next-call sentence.
    assert.match(vars.next_call_line, /खाने के बाद/);
    assert.match(vars.food_line, /खाने के बाद/);
    assert.match(out.variables.next_call_line, /कॉल करूँगी/);
  });

  test('caps the turns, because the default is 10000', async (t) => {
    let sent;
    const f = mock.method(globalThis, 'fetch', async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => SIMPLE, text: async () => '' };
    });
    t.after(() => f.mock.restore());
    await runDemoCall({
      repository: REPO, phone: '+91', parentName: 'क', drugName: 'M',
      agentId: 'a', apiKey: 'k',
    });
    assert.ok(sent.new_turns_limit > 0 && sent.new_turns_limit <= 20, 'turn limit must be small');
  });

  test('every persona is usable and describes itself', async (t) => {
    const f = elevenLabsReplies(SIMPLE);
    t.after(() => f.mock.restore());
    for (const key of Object.keys(PERSONAS)) {
      const out = await runDemoCall({
        repository: REPO, phone: '+91', parentName: 'क', drugName: 'M',
        persona: key, agentId: 'a', apiKey: 'k',
      });
      assert.strictEqual(out.persona, key);
      assert.ok(out.persona_label && out.persona_label.length > 3, key);
    }
  });

  test('an unknown persona is refused rather than silently defaulted', async () => {
    await assert.rejects(
      () => runDemoCall({
        repository: REPO, phone: '+91', parentName: 'क', drugName: 'M',
        persona: 'nonsense', agentId: 'a', apiKey: 'k',
      }),
      /Unknown persona/
    );
  });

  test('says so when ElevenLabs is not configured, rather than throwing a fetch error', async () => {
    await assert.rejects(
      () => runDemoCall({ repository: REPO, phone: '+91', parentName: 'क', drugName: 'M', agentId: '', apiKey: '' }),
      (e) => e.code === 'not_configured'
    );
  });

  test('reports an upstream failure with its status attached', async (t) => {
    const f = elevenLabsReplies({ detail: 'nope' }, { ok: false, status: 429 });
    t.after(() => f.mock.restore());
    await assert.rejects(
      () => runDemoCall({ repository: REPO, phone: '+91', parentName: 'क', drugName: 'M', agentId: 'a', apiKey: 'k' }),
      (e) => e.code === 'upstream_failed' && e.status === 429
    );
  });

  test('declares what it did not test, so the UI cannot imply a rehearsal', async (t) => {
    // Tool calls are mocked and no audio is produced. A caregiver reading this
    // must not come away believing a dose was recorded or the call was heard.
    const f = elevenLabsReplies(SIMPLE);
    t.after(() => f.mock.restore());
    const out = await runDemoCall({
      repository: REPO, phone: '+91', parentName: 'क', drugName: 'M', agentId: 'a', apiKey: 'k',
    });
    assert.deepStrictEqual(out.notes, { no_audio: true, tools_mocked: true, nothing_recorded: true });
  });

  test('a patient with no schedule still demos, with the lines left empty', async (t) => {
    const f = elevenLabsReplies(SIMPLE);
    t.after(() => f.mock.restore());
    const out = await runDemoCall({
      repository: { async findPatientByPhone() { return null; }, async findMedicationsForPatient() { return []; } },
      phone: '+91', parentName: 'क', drugName: 'M', agentId: 'a', apiKey: 'k',
    });
    assert.strictEqual(out.variables.next_call_line, '');
    assert.strictEqual(out.variables.food_line, '');
    assert.ok(out.turns.length > 0);
  });
});

describe('transcript presentation', () => {
  test('strips the expressive tags a simulation leaves behind', async (t) => {
    // [slow]/[sad]/[happy] appear in simulated transcripts and in none of the
    // real calls — TTS consumes them as delivery. A caregiver reading the demo
    // must not see stage directions the person on the phone would never hear.
    const f = mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        simulated_conversation: [
          { role: 'agent', message: 'ठीक है। [slow] क्या  मैं जान सकती हूँ?' },
          { role: 'agent', message: '[happy] बहुत अच्छा।' },
        ],
      }),
      text: async () => '',
    }));
    t.after(() => f.mock.restore());
    const out = await runDemoCall({
      repository: REPO, phone: '+91', parentName: 'क', drugName: 'M', agentId: 'a', apiKey: 'k',
    });
    for (const turn of out.turns) {
      assert.doesNotMatch(turn.message || '', /\[[a-zA-Z]/, turn.message);
    }
    assert.strictEqual(out.turns[0].message, 'ठीक है। क्या मैं जान सकती हूँ?');
  });
});
