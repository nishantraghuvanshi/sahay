'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { loadProvidersConfig } = require('../src/core/config/loader');

describe('loadProvidersConfig', () => {
  test('loads providers.yaml and returns parsed config', () => {
    const config = loadProvidersConfig();
    assert.ok(config.active, 'config should have active section');
    assert.ok(config.stt, 'config should have stt section');
    assert.ok(config.llm, 'config should have llm section');
    assert.ok(config.tts, 'config should have tts section');
  });

  test('active providers point to existing config entries', () => {
    const config = loadProvidersConfig();
    for (const type of ['stt', 'llm', 'tts']) {
      const activeName = config.active[type];
      assert.ok(config[type][activeName], `active.${type}="${activeName}" but no config found`);
    }
  });

  test('sarvam STT config has expected fields', () => {
    const config = loadProvidersConfig();
    const stt = config.stt.sarvam;
    assert.ok(stt.model, 'stt.sarvam should have model');
    assert.ok(stt.language, 'stt.sarvam should have language');
    assert.ok(stt.api_key_env, 'stt.sarvam should have api_key_env');
  });

  test('sarvam LLM config has expected fields', () => {
    const config = loadProvidersConfig();
    const llm = config.llm.sarvam;
    assert.ok(llm.model, 'llm.sarvam should have model');
    assert.ok(llm.base_url, 'llm.sarvam should have base_url');
    assert.ok(llm.api_key_env, 'llm.sarvam should have api_key_env');
  });

  test('sarvam TTS config has expected fields', () => {
    const config = loadProvidersConfig();
    const tts = config.tts.sarvam;
    assert.ok(tts.model, 'tts.sarvam should have model');
    assert.ok(tts.speaker, 'tts.sarvam should have speaker');
    assert.ok(tts.api_key_env, 'tts.sarvam should have api_key_env');
  });

  test('default active providers are sarvam', () => {
    const config = loadProvidersConfig();
    assert.strictEqual(config.active.stt, 'sarvam');
    assert.strictEqual(config.active.llm, 'sarvam');
    assert.strictEqual(config.active.tts, 'sarvam');
  });

  test('groq LLM is configured as alternative', () => {
    const config = loadProvidersConfig();
    assert.ok(config.llm.groq, 'groq should be configured as LLM alternative');
    assert.ok(config.llm.groq.model);
  });

  test('deepgram STT is configured as alternative', () => {
    const config = loadProvidersConfig();
    assert.ok(config.stt.deepgram, 'deepgram should be configured as STT alternative');
    assert.ok(config.stt.deepgram.model);
  });

  test('TTS pace is set for elderly-friendly speech', () => {
    const config = loadProvidersConfig();
    assert.ok(config.tts.sarvam.pace <= 1.0, 'pace should be <= 1.0 for slower speech');
  });
});

describe('MedicationAdherenceStrategy config loading', () => {
  const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

  test('strategy loads use-case YAML config', () => {
    const strategy = new MedicationAdherenceStrategy();
    assert.ok(strategy.config, 'strategy should have loaded config');
    assert.ok(strategy.config.system_prompt, 'config should have system_prompt');
    assert.ok(strategy.config.first_message, 'config should have first_message');
    assert.ok(strategy.config.version, 'config should have version');
  });

  test('strategy name is medication-adherence', () => {
    const strategy = new MedicationAdherenceStrategy();
    assert.strictEqual(strategy.name, 'medication-adherence');
  });

  test('buildSystemPrompt substitutes variables', () => {
    const strategy = new MedicationAdherenceStrategy();
    const prompt = strategy.buildSystemPrompt({ drug_name: 'Paracetamol' });
    assert.ok(prompt.includes('Paracetamol'), 'drug_name should be substituted');
  });

  test('buildFirstMessage substitutes variables', () => {
    const strategy = new MedicationAdherenceStrategy();
    const msg = strategy.buildFirstMessage({ parent_name: 'Sunita', drug_name: 'Crocin' });
    assert.ok(msg.includes('Sunita'), 'parent_name should be substituted');
    assert.ok(msg.includes('Crocin'), 'drug_name should be substituted');
  });

  test('buildFirstMessage merges config variables with call variables', () => {
    const strategy = new MedicationAdherenceStrategy();
    const msg = strategy.buildFirstMessage({ parent_name: 'Sunita' });
    // drug_name comes from config variables, parent_name from call variables
    assert.ok(msg.includes('Sunita'));
    assert.ok(msg.includes('Crocin'));
  });

  test('getTools returns report_outcome tool', () => {
    const strategy = new MedicationAdherenceStrategy();
    const tools = strategy.getTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].function.name, 'report_outcome');
  });

  test('shouldEscalate returns true for ESCALATED_SYMPTOM', () => {
    const strategy = new MedicationAdherenceStrategy();
    assert.ok(strategy.shouldEscalate({ label: 'ESCALATED_SYMPTOM' }));
  });

  test('shouldEscalate returns false for CONFIRMED', () => {
    const strategy = new MedicationAdherenceStrategy();
    assert.ok(!strategy.shouldEscalate({ label: 'CONFIRMED' }));
  });

  test('shouldEscalate returns false for DENIED', () => {
    const strategy = new MedicationAdherenceStrategy();
    assert.ok(!strategy.shouldEscalate({ label: 'DENIED' }));
  });

  test('getConfig returns expected fields', () => {
    const strategy = new MedicationAdherenceStrategy();
    const cfg = strategy.getConfig();
    assert.ok(cfg.version);
    assert.ok(cfg.silenceTimeoutSeconds);
    assert.ok(cfg.maxDurationSeconds);
    assert.strictEqual(cfg.maxDurationSeconds, 90);
  });

  test('getPromptVersion returns version from config', () => {
    // Asserted against the YAML rather than a literal — the version is meant to
    // change whenever the prompt does, and that shouldn't fail the suite.
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const path = require('node:path');
    const expected = yaml.load(
      fs.readFileSync(
        path.join(__dirname, '..', 'config', 'use-cases', 'medication-adherence.yaml'),
        'utf8'
      )
    ).version;

    const strategy = new MedicationAdherenceStrategy();
    assert.strictEqual(strategy.getPromptVersion(), expected);
    assert.ok(expected >= 2, 'prompt version should be at least 2 after the label split');
  });

  test('getVariables returns config variables', () => {
    const strategy = new MedicationAdherenceStrategy();
    const vars = strategy.getVariables();
    assert.ok(vars.parent_name);
    assert.ok(vars.drug_name);
  });
});

describe('UseCaseRegistry', () => {
  const { USE_CASES, getUseCase, getActiveUseCase } = require('../src/use-cases/registry');

  test('registers medication-adherence use case', () => {
    assert.ok(USE_CASES['medication-adherence']);
  });

  test('getUseCase returns the use case module', () => {
    const uc = getUseCase('medication-adherence');
    assert.strictEqual(uc.name, 'medication-adherence');
    assert.ok(uc.strategy);
  });

  test('getUseCase throws for unknown use case', () => {
    assert.throws(() => getUseCase('nonexistent'), /Unknown use case/);
  });

  test('getActiveUseCase defaults to medication-adherence', () => {
    delete process.env.USE_CASE;
    const uc = getActiveUseCase();
    assert.strictEqual(uc.name, 'medication-adherence');
  });
});

describe('ProviderRegistry', () => {
  const ProviderRegistry = require('../src/adapters/providers/registry');

  test('getActiveSTT returns the active STT adapter instance', () => {
    const reg = new ProviderRegistry();
    const stt = reg.getActiveSTT();
    assert.ok(stt, 'should return an STT adapter');
    assert.strictEqual(typeof stt.init, 'function');
    assert.strictEqual(typeof stt.transcribe, 'function');
  });

  test('getActiveLLM returns the active LLM adapter instance', () => {
    const reg = new ProviderRegistry();
    const llm = reg.getActiveLLM();
    assert.ok(llm, 'should return an LLM adapter');
    assert.strictEqual(typeof llm.chatCompletion, 'function');
  });

  test('getActiveTTS returns the active TTS adapter instance', () => {
    const reg = new ProviderRegistry();
    const tts = reg.getActiveTTS();
    assert.ok(tts, 'should return a TTS adapter');
    assert.strictEqual(typeof tts.synthesize, 'function');
  });

  test('getActiveProviderNames returns configured active providers', () => {
    const reg = new ProviderRegistry();
    const names = reg.getActiveProviderNames();
    assert.ok(typeof names === 'object');
    assert.ok(names.stt, 'should have stt name');
    assert.ok(names.llm, 'should have llm name');
    assert.ok(names.tts, 'should have tts name');
    assert.strictEqual(names.stt, 'sarvam');
    assert.strictEqual(names.llm, 'sarvam');
    assert.strictEqual(names.tts, 'sarvam');
  });

  test('getSTTConfig returns provider-specific config', () => {
    const reg = new ProviderRegistry();
    const cfg = reg.getSTTConfig();
    assert.ok(cfg.model);
    assert.ok(cfg.api_key_env);
  });

  test('getLLMConfig returns provider-specific config', () => {
    const reg = new ProviderRegistry();
    const cfg = reg.getLLMConfig();
    assert.ok(cfg.model);
    assert.ok(cfg.base_url);
  });

  test('getTTSConfig returns provider-specific config', () => {
    const reg = new ProviderRegistry();
    const cfg = reg.getTTSConfig();
    assert.ok(cfg.model);
    assert.ok(cfg.speaker);
  });
});

describe('ConsoleRepository', () => {
  const ConsoleRepository = require('../src/adapters/persistence/console');

  test('save logs outcome to console without error', async () => {
    const repo = new ConsoleRepository();
    await repo.save({ callId: 'test', label: 'CONFIRMED' });
    // No assertion — just should not throw
  });

  test('list returns empty array in Phase 0', async () => {
    const repo = new ConsoleRepository();
    const results = await repo.list();
    assert.deepStrictEqual(results, []);
  });

  test('extends OutcomeRepositoryPort', () => {
    const OutcomeRepositoryPort = require('../src/core/ports/repository');
    const repo = new ConsoleRepository();
    assert.ok(repo instanceof OutcomeRepositoryPort);
  });
});
