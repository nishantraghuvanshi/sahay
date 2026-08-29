'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  loadProvidersConfig,
  validateProvidersConfig,
} = require('../src/core/config/loader');
const ProviderRegistry = require('../src/adapters/providers/registry');

/**
 * Provider integration tests.
 *
 * A provider is either `bridge` (audio/tokens flow through this server, so an
 * adapter must exist) or `native` (the orchestrator runs it directly, so no
 * adapter should exist). The key is `integration` and not `mode` because
 * stt.sarvam already uses `mode` for transcribe-vs-translate — overloading it
 * would have made two unrelated settings share one name.
 *
 * Before this distinction was explicit, providers.yaml
 * advertised deepgram/openai/elevenlabs while registry.js mapped none of them —
 * a config entry you could not actually select, with a green test suite.
 */

const INTEGRATIONS = ['bridge', 'native'];

describe('providers.yaml declares an integration for every provider', () => {
  const config = loadProvidersConfig();

  for (const type of ['stt', 'llm', 'tts']) {
    test(`every ${type} provider declares a valid integration`, () => {
      for (const [name, entry] of Object.entries(config[type])) {
        assert.ok(entry.integration, `${type}.${name} is missing "integration"`);
        assert.ok(
          INTEGRATIONS.includes(entry.integration),
          `${type}.${name}.integration="${entry.integration}" is not one of ${INTEGRATIONS.join('|')}`
        );
      }
    });
  }

  test('sarvam is bridged on all three types', () => {
    assert.strictEqual(config.stt.sarvam.integration, 'bridge');
    assert.strictEqual(config.llm.sarvam.integration, 'bridge');
    assert.strictEqual(config.tts.sarvam.integration, 'bridge');
  });

  test('deepgram STT is native — the orchestrator runs it, we do not', () => {
    assert.strictEqual(config.stt.deepgram.integration, 'native');
  });

  test('openai LLM is bridged and therefore selectable', () => {
    assert.strictEqual(config.llm.openai.integration, 'bridge');
  });
});

describe('validateProvidersConfig', () => {
  /** Minimal valid config, cloned per test so mutations do not leak. */
  const valid = () => ({
    active: { transport: 'vapi', stt: 'sarvam', llm: 'sarvam', tts: 'sarvam' },
    transport: { vapi: {} },
    stt: { sarvam: { integration: 'bridge' } },
    llm: { sarvam: { integration: 'bridge' } },
    tts: { sarvam: { integration: 'bridge' } },
  });

  test('accepts a well-formed config', () => {
    assert.doesNotThrow(() => validateProvidersConfig(valid()));
  });

  test('rejects a missing active section', () => {
    const c = valid();
    delete c.active;
    assert.throws(() => validateProvidersConfig(c), /missing "active"/);
  });

  test('rejects a missing active.transport', () => {
    const c = valid();
    delete c.active.transport;
    assert.throws(() => validateProvidersConfig(c), /active\.transport/);
  });

  test('rejects an active provider with no config entry', () => {
    const c = valid();
    c.active.llm = 'nonexistent';
    assert.throws(() => validateProvidersConfig(c), /no config under llm\.nonexistent/);
  });

  test('rejects an active transport with no config entry', () => {
    const c = valid();
    c.active.transport = 'nonexistent';
    assert.throws(() => validateProvidersConfig(c), /no config under transport\.nonexistent/);
  });

  test('rejects a provider with no integration', () => {
    const c = valid();
    delete c.stt.sarvam.integration;
    assert.throws(() => validateProvidersConfig(c), /stt\.sarvam.*integration/);
  });

  test('rejects a provider with an unknown integration', () => {
    const c = valid();
    c.tts.sarvam.integration = 'proxy';
    assert.throws(() => validateProvidersConfig(c), /tts\.sarvam.*proxy/);
  });
});

describe('ProviderRegistry enforces the integration contract', () => {
  test('constructs against the real config without throwing', () => {
    assert.doesNotThrow(() => new ProviderRegistry());
  });

  test('isBridged reports the configured integration', () => {
    const reg = new ProviderRegistry();
    assert.strictEqual(reg.isBridged('stt'), true, 'active stt (sarvam) is bridged');
    assert.strictEqual(reg.isBridged('llm'), true);
    assert.strictEqual(reg.isBridged('tts'), true);
  });

  test('every bridge provider in config has a registered adapter', () => {
    // This is the invariant that was silently violated: a bridge provider
    // without an adapter is a config entry that throws only when selected.
    const reg = new ProviderRegistry();
    const missing = reg.findUnbackedBridgeProviders();
    assert.deepStrictEqual(
      missing,
      [],
      `bridge providers with no adapter: ${missing.join(', ')}`
    );
  });

  test('no native provider has a bridge adapter registered', () => {
    const reg = new ProviderRegistry();
    const stray = reg.findNativeProvidersWithAdapters();
    assert.deepStrictEqual(
      stray,
      [],
      `native providers that also register an adapter: ${stray.join(', ')}`
    );
  });

  test('asking for a bridge adapter on a native provider fails loudly', () => {
    const reg = new ProviderRegistry();
    // deepgram is native — selecting it must not silently yield an adapter.
    assert.throws(
      () => reg.getBridgeAdapter('stt', 'deepgram'),
      /native/i,
      'should explain that native providers have no bridge adapter'
    );
  });

  test('getBridgeAdapter returns an instance for a bridged provider', () => {
    const reg = new ProviderRegistry();
    const openai = reg.getBridgeAdapter('llm', 'openai');
    assert.strictEqual(typeof openai.chatCompletion, 'function');
    assert.strictEqual(typeof openai.chatCompletionStream, 'function');
  });

  test('getBridgeAdapter throws a listing error for an unknown provider', () => {
    const reg = new ProviderRegistry();
    assert.throws(() => reg.getBridgeAdapter('llm', 'nope'), /Unknown llm provider/);
  });
});

describe('OpenAI LLM adapter', () => {
  const OpenAILLMAdapter = require('../src/adapters/providers/llm/openai');
  const LLMPort = require('../src/core/ports/llm');

  test('implements the LLM port', () => {
    const adapter = new OpenAILLMAdapter();
    assert.ok(adapter instanceof LLMPort);
  });

  test('rejects when the configured api key env var is absent', async () => {
    const adapter = new OpenAILLMAdapter();
    await assert.rejects(
      () =>
        adapter.chatCompletion(
          { messages: [] },
          { api_key_env: 'DEFINITELY_UNSET_KEY_FOR_TEST', base_url: 'http://x', model: 'm' },
          {}
        ),
      /Missing env var: DEFINITELY_UNSET_KEY_FOR_TEST/
    );
  });

  test('streaming rejects when the api key env var is absent', async () => {
    const adapter = new OpenAILLMAdapter();
    await assert.rejects(
      () =>
        adapter.chatCompletionStream(
          { messages: [] },
          { api_key_env: 'DEFINITELY_UNSET_KEY_FOR_TEST', base_url: 'http://x', model: 'm' },
          {},
          () => {}
        ),
      /Missing env var: DEFINITELY_UNSET_KEY_FOR_TEST/
    );
  });
});
