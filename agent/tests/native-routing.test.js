'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');
const { loadProvidersConfig } = require('../src/core/config/loader');

/**
 * Task 1 & 2 — `integration` in providers.yaml must govern runtime behaviour,
 * not just pass ProviderRegistry's boot-time contract check.
 *
 * Before this test, `VapiTransportAdapter.start()` registered all three
 * bridge routes unconditionally, and `buildAssistantConfig()` branched on
 * provider *name* rather than `isBridged()` — so a provider marked
 * `integration: native` still got routed back through this server (or,
 * for LLM, a bridge provider named "openai" got the wrong shape and no
 * server at all). No network calls or credentials are needed: everything
 * here is driven by a stubbed ProviderRegistry.
 */

/** Build a stubbed ProviderRegistry reporting a fixed bridge/native combo. */
function stubRegistry({ stt, llm, tts }) {
  return {
    isBridged(type) {
      return { stt, llm, tts }[type];
    },
    getActiveProviderNames() {
      return { transport: 'vapi', stt: 'sarvam', llm: 'openai', tts: 'elevenlabs' };
    },
  };
}

/** Minimal providers config block covering every branch under test. */
const PROVIDERS = {
  active: { transport: 'vapi', stt: 'sarvam', llm: 'openai', tts: 'elevenlabs' },
  stt: {
    sarvam: { integration: 'bridge', model: 'saaras:v3', language: 'hi-IN' },
    deepgram: { integration: 'native', model: 'nova-3', language: 'hi' },
  },
  llm: {
    sarvam: { integration: 'bridge', model: 'sarvam-105b', temperature: 0.3, max_tokens: 250 },
    openai: { integration: 'bridge', model: 'gpt-4o-mini', temperature: 0.3, max_tokens: 250 },
  },
  tts: {
    sarvam: { integration: 'bridge', model: 'bulbul:v3' },
    elevenlabs: {
      integration: 'native',
      model: 'eleven_turbo_v2_5',
      voice_id: 'QTKSa2Iyv0yoxvXY2V8a',
      stability: 0.5,
      similarity_boost: 0.75,
    },
  },
};

const WEBHOOK_URL = 'http://localhost:3001';

/** Collect which routes got registered, without starting a real server. */
async function routesRegisteredFor(combo) {
  const registry = stubRegistry(combo);
  const transport = new VapiTransportAdapter(registry);

  const wsHandlers = [];
  const wss = { on: (event, handler) => wsHandlers.push({ event, handler }) };
  const app = express();

  await transport.start(null, { getEventBus: () => ({ emit: async () => {} }) }, {
    wss,
    app,
    providersConfig: PROVIDERS,
    strategy: {},
    repository: {},
    webhookUrl: WEBHOOK_URL,
  });

  const registeredPaths = app._router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`));

  return {
    stt: wsHandlers.some((h) => h.event === 'connection'),
    llm: registeredPaths.includes('POST /llm/chat/completions'),
    tts: registeredPaths.includes('POST /api/tts/:provider'),
    webhook: registeredPaths.includes('POST /webhook'),
  };
}

describe('Task 1 — route registration follows integration, not a hardcoded default', () => {
  test('all-bridge: every route registers (today\'s behaviour, unchanged)', async () => {
    const routes = await routesRegisteredFor({ stt: true, llm: true, tts: true });
    assert.deepStrictEqual(routes, { stt: true, llm: true, tts: true, webhook: true });
  });

  test('all-native: no bridge route registers, but /webhook always does', async () => {
    const routes = await routesRegisteredFor({ stt: false, llm: false, tts: false });
    assert.deepStrictEqual(routes, { stt: false, llm: false, tts: false, webhook: true });
  });

  test('target mixed config (stt bridge / llm bridge / tts native)', async () => {
    const routes = await routesRegisteredFor({ stt: true, llm: true, tts: false });
    assert.deepStrictEqual(routes, { stt: true, llm: true, tts: false, webhook: true });
  });

  test('/webhook is present in every combination', async () => {
    for (const combo of [
      { stt: true, llm: true, tts: true },
      { stt: false, llm: true, tts: true },
      { stt: true, llm: false, tts: true },
      { stt: true, llm: true, tts: false },
      { stt: false, llm: false, tts: false },
    ]) {
      const routes = await routesRegisteredFor(combo);
      assert.strictEqual(routes.webhook, true, `webhook missing for ${JSON.stringify(combo)}`);
    }
  });
});

describe('Task 2 — buildAssistantConfig emits native or custom shapes per isBridged', () => {
  const strategy = new MedicationAdherenceStrategy('hi');

  function configFor(combo) {
    const registry = stubRegistry(combo);
    const transport = new VapiTransportAdapter(registry);
    return transport.buildAssistantConfig(strategy, PROVIDERS, WEBHOOK_URL, { mode: 'outbound' });
  }

  test('all-bridge: transcriber, model and voice all point at our server', () => {
    const config = configFor({ stt: true, llm: true, tts: true });

    assert.strictEqual(config.transcriber.provider, 'custom-transcriber');
    // ?api_key=<secret> is appended for the WS handshake (see vapiSecretAuth
    // / authenticateVapiWebSocket in auth.js) — the path itself still ends
    // at /api/stt.
    assert.match(config.transcriber.server.url, /\/api\/stt\?api_key=/);

    assert.strictEqual(config.model.provider, 'custom-llm');
    assert.strictEqual(config.model.url, `${WEBHOOK_URL}/llm/chat/completions`);

    assert.strictEqual(config.voice.provider, 'custom-voice');
    assert.match(config.voice.server.url, /\/api\/tts\/elevenlabs$/);
  });

  test('target mixed config: stt/llm stay custom, voice goes native', () => {
    const config = configFor({ stt: true, llm: true, tts: false });

    assert.strictEqual(config.transcriber.provider, 'custom-transcriber');
    assert.ok(config.transcriber.server.url.includes(WEBHOOK_URL.replace(/^http/, 'ws')));

    assert.strictEqual(config.model.provider, 'custom-llm');
    assert.strictEqual(config.model.model, 'gpt-4o-mini');
    assert.strictEqual(config.model.url, `${WEBHOOK_URL}/llm/chat/completions`);
    assert.ok(Array.isArray(config.model.messages));

    assert.strictEqual(config.voice.provider, '11labs');
    assert.strictEqual(config.voice.voiceId, 'QTKSa2Iyv0yoxvXY2V8a');
    assert.strictEqual(config.voice.model, 'eleven_turbo_v2_5');
    assert.strictEqual(config.voice.server, undefined);

    // A native voice block must reference nothing on our server.
    const voiceJson = JSON.stringify(config.voice);
    assert.ok(!voiceJson.includes(WEBHOOK_URL), 'native voice config must not reference our server');
  });

  test('all-native: transcriber and model also go native', () => {
    const config = configFor({ stt: false, llm: false, tts: false });

    assert.strictEqual(config.transcriber.provider, 'sarvam');
    assert.strictEqual(config.transcriber.model, 'saaras:v3');
    assert.strictEqual(config.transcriber.language, 'hi-IN');
    assert.strictEqual(config.transcriber.server, undefined);

    assert.strictEqual(config.model.provider, 'openai');
    assert.strictEqual(config.model.model, 'gpt-4o-mini');
    assert.strictEqual(config.model.temperature, 0.3);
    assert.strictEqual(config.model.maxTokens, 250);
    assert.ok(Array.isArray(config.model.messages));
    assert.ok(Array.isArray(config.model.tools));
    assert.strictEqual(config.model.url, undefined);

    assert.strictEqual(config.voice.provider, '11labs');
  });
});

describe('Task 3 — real ElevenLabs voice_id, not a placeholder', () => {
  test('is 20 characters, matching real ElevenLabs voice IDs', () => {
    const config = loadProvidersConfig();
    assert.strictEqual(
      config.tts.elevenlabs.voice_id.length,
      20,
      'a 13-character placeholder ID must never be reintroduced silently'
    );
  });
});
