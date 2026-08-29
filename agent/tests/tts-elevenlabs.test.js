'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ElevenLabsTTSAdapter = require('../src/adapters/providers/tts/elevenlabs');
const TTSPort = require('../src/core/ports/tts');
const { loadProvidersConfig } = require('../src/core/config/loader');
const ProviderRegistry = require('../src/adapters/providers/registry');

/**
 * Task 2 — ElevenLabs TTS bridge adapter.
 *
 * The playground has no Vapi to run ElevenLabs for it, so it always
 * bridges — this adapter exists so the playground hears the same voice a
 * phone caller does. These tests never hit the real ElevenLabs API; the
 * request/response shape is UNVERIFIED (see the adapter's doc comment) and
 * flagged as such rather than trusted.
 */

describe('ElevenLabsTTSAdapter', () => {
  test('implements the TTS port', () => {
    const adapter = new ElevenLabsTTSAdapter();
    assert.ok(adapter instanceof TTSPort);
  });

  test('rejects when the configured api key env var is absent', async () => {
    const adapter = new ElevenLabsTTSAdapter();
    await assert.rejects(
      () =>
        adapter.synthesize(
          { text: 'नमस्ते', sampleRate: 16000 },
          {
            api_key_env: 'DEFINITELY_UNSET_ELEVENLABS_KEY_FOR_TEST',
            model: 'eleven_turbo_v2_5',
            voice_id: 'voice-123',
            stability: 0.5,
            similarity_boost: 0.75,
          },
          {}
        ),
      /Missing env var: DEFINITELY_UNSET_ELEVENLABS_KEY_FOR_TEST/
    );
  });

  test('sends the config-sourced voice, model and settings — not hardcoded values', async () => {
    const adapter = new ElevenLabsTTSAdapter();
    let capturedUrl;
    let capturedBody;
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      };
    };

    try {
      await adapter.synthesize(
        { text: 'hello', sampleRate: 22050 },
        {
          api_key_env: 'TEST_ELEVENLABS_KEY',
          model: 'eleven_turbo_v2_5',
          voice_id: 'my-configured-voice-id',
          stability: 0.42,
          similarity_boost: 0.9,
        },
        { TEST_ELEVENLABS_KEY: 'secret' }
      );
    } finally {
      global.fetch = originalFetch;
    }

    assert.ok(capturedUrl.includes('my-configured-voice-id'), 'voice_id from config should be in the URL');
    assert.ok(capturedUrl.includes('output_format=pcm_22050'), 'output_format should match the requested sample rate');
    assert.strictEqual(capturedBody.model_id, 'eleven_turbo_v2_5');
    assert.strictEqual(capturedBody.voice_settings.stability, 0.42);
    assert.strictEqual(capturedBody.voice_settings.similarity_boost, 0.9);
  });

  test('returns the raw response body as a Buffer', async () => {
    const adapter = new ElevenLabsTTSAdapter();
    const originalFetch = global.fetch;
    const fakePcm = new Uint8Array([1, 2, 3, 4]).buffer;
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => fakePcm });

    try {
      const result = await adapter.synthesize(
        { text: 'hi', sampleRate: 16000 },
        { api_key_env: 'TEST_ELEVENLABS_KEY', model: 'm', voice_id: 'v', stability: 0.5, similarity_boost: 0.5 },
        { TEST_ELEVENLABS_KEY: 'secret' }
      );
      assert.ok(Buffer.isBuffer(result));
      assert.deepStrictEqual([...result], [1, 2, 3, 4]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('ProviderRegistry — playground bridging of a native provider', () => {
  test('getPlaygroundAdapter returns the ElevenLabs adapter even though tts is integration: native', () => {
    const reg = new ProviderRegistry();
    assert.strictEqual(reg.config.tts[reg.config.active.tts].integration, 'native');

    const adapter = reg.getActivePlaygroundTTS();
    assert.ok(adapter instanceof ElevenLabsTTSAdapter);
  });

  test('getActiveTTS (phone-path accessor) still throws for the same native provider', () => {
    // Rule 2 is relaxed, but getActiveTTS is unrelated to it — it is the
    // phone-path accessor and must keep refusing a native provider exactly
    // as before; only getPlaygroundAdapter reaches past that.
    const reg = new ProviderRegistry();
    assert.throws(() => reg.getActiveTTS(), /integration: native/);
  });

  test('providers.yaml still declares a valid integration for every provider', () => {
    const config = loadProvidersConfig();
    assert.strictEqual(config.tts.elevenlabs.integration, 'native');
    assert.strictEqual(config.tts.sarvam.integration, 'bridge');
  });
});
