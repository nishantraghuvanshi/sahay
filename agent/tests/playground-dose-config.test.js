'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PlaygroundConversation } = require('../src/playground/conversation');
const PlaygroundTransportAdapter = require('../src/adapters/transport/playground');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const { FOOD_LINES, FOOD_QUESTION } = require('../src/use-cases/medication-adherence/scheduling/call-variables');

/**
 * What the playground's left rail picks has to reach the PROMPT, not just the
 * greeting.
 *
 * The medicine and the before/after-meal choice were being spoken in the first
 * message and nowhere else, so the moment the caller asked "before food or
 * after?" the agent had nothing on file: {food_line} was empty, and the prompt
 * — rightly — forbids composing a food instruction it was never given. The
 * choice was on screen and absent from the conversation.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-dose-config-')), 'test.db');
  tmpDbs.push(dbPath);
  return new SqliteRepository({ dbPath });
}

after(() => {
  for (const p of tmpDbs) fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

const PHONE = '+919876500099';

/**
 * Start a conversation with a given dose config and capture the system prompt
 * it composed, by standing in for the strategy's prompt builder.
 */
async function promptFor({ drugName, mealRelation, meal, language = 'hi' }) {
  const repo = freshRepo();
  const transport = new PlaygroundTransportAdapter(null);
  transport.repository = repo;

  const captured = {};
  const conversation = new PlaygroundConversation({
    providerRegistry: {
      getActiveSTT: () => ({ init: async () => {}, transcribe: async () => {}, dispose: async () => {} }),
      getSTTConfig: () => ({}),
      getActiveLLM: () => ({ chatCompletionStream: async () => ({ content: '', tool_calls: [] }) }),
      getLLMConfig: () => ({}),
      getActivePlaygroundTTS: () => ({ synthesize: async () => Buffer.from([0, 0]) }),
      getTTSConfig: () => ({}),
    },
    strategy: new MedicationAdherenceStrategy(language),
    transport,
    language,
    phone: PHONE,
    direction: 'outbound',
    drugName,
    mealRelation,
    meal,
    onAudio: () => {},
    onAgentResponse: () => {},
    onError: (err) => { throw err; },
  });

  const real = conversation.langStrategy;
  conversation.langStrategy = {
    ...real,
    getConfig: () => real.getConfig(),
    getTools: () => real.getTools(),
    buildSystemPrompt: (vars, mode) => {
      captured.system = real.buildSystemPrompt(vars, mode);
      captured.vars = vars;
      return captured.system;
    },
    buildFirstMessage: (vars, mode) => {
      captured.first = real.buildFirstMessage(vars, mode);
      return captured.first;
    },
  };

  await conversation.start();
  await conversation.stop();
  return captured;
}

describe('Playground dose config reaches the prompt', () => {
  test('an after-meal dose carries the food question and the food line', async () => {
    const captured = await promptFor({ drugName: 'Metformin', mealRelation: 'after', meal: 'lunch' });

    assert.strictEqual(captured.vars.food_question, FOOD_QUESTION);
    assert.strictEqual(captured.vars.food_line, FOOD_LINES.after);
    // Not just passed — actually substituted into the composed prompt, which is
    // the only form the model ever sees.
    assert.ok(
      captured.system.includes(FOOD_LINES.after),
      'the system prompt should carry the food line verbatim',
    );
    assert.ok(!captured.system.includes('{food_line}'), 'no placeholder should survive');
  });

  test('a before-meal dose carries the before-meal line, not the after one', async () => {
    const captured = await promptFor({ drugName: 'Metformin', mealRelation: 'before', meal: 'breakfast' });

    assert.strictEqual(captured.vars.food_line, FOOD_LINES.before);
    assert.ok(captured.system.includes(FOOD_LINES.before));
    assert.ok(!captured.system.includes(FOOD_LINES.after));
  });

  test('the picked medicine is what the prompt and the greeting both name', async () => {
    const captured = await promptFor({ drugName: 'Thyronorm', mealRelation: 'before', meal: 'breakfast' });

    assert.strictEqual(captured.vars.drug_name, 'Thyronorm');
    assert.ok(captured.system.includes('Thyronorm'), 'the clarify branches name the medicine');
    assert.ok(captured.first.includes('Thyronorm'));
    assert.ok(captured.first.includes('नाश्ते से पहले'), `greeting was: ${captured.first}`);
  });

  test('with no meal relation picked, nothing about food is put in the prompt', async () => {
    const captured = await promptFor({ drugName: 'Crocin' });

    assert.strictEqual(captured.vars.food_question, '');
    assert.strictEqual(captured.vars.food_line, '');
    assert.strictEqual(captured.vars.food_wait_line, '');
    // The prompt still DISCUSSES food — it has to, to say when to keep quiet
    // about it — so the check is that no placeholder survived unfilled and no
    // line the agent is told to speak verbatim carries a food instruction.
    assert.ok(!captured.system.includes('{food_line}'));
    assert.ok(!captured.system.includes('{food_wait_line}'));
    assert.ok(!captured.system.includes('{food_question}'));
  });
});
