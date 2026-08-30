'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const SarvamSTTAdapter = require('../src/adapters/providers/stt/sarvam');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');
const logger = require('../src/utils/logger');

/**
 * FIX6 — two real calls both died `silence-timed-out` with an empty
 * transcript. Root cause: telephony audio arrives at 8kHz, but Sarvam was
 * always connected at the configured 16000, regardless of what Vapi's
 * `start` message announced. The transport already logged the mismatch and
 * named the consequence ("expect empty or garbled transcripts"), then
 * proceeded anyway.
 *
 * These tests cover two layers:
 *  - vapi.js: the announced sampleRate must flow through to the STT
 *    adapter's transcribe() opts, exactly as streamChannels already does.
 *  - sarvam.js: transcribe() must use the per-call announced rate for both
 *    the Sarvam connect URL and every chunk's WAV header, falling back to
 *    the configured default only when nothing was announced.
 */

// ---------------------------------------------------------------------------
// Fake `ws` used to test sarvam.js without a real network call. Installed
// into require.cache for 'ws' because sarvam.js does `require('ws')` lazily,
// inside _connectSarvam() — so swapping the cache entry before a test calls
// transcribe() is enough; no module-loader hooks needed.
// ---------------------------------------------------------------------------
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    FakeWebSocket.instances.push(this);
    process.nextTick(() => {
      if (this.readyState === 0) {
        this.readyState = 1; // OPEN
        this.emit('open');
      }
    });
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}
FakeWebSocket.instances = [];

const WS_PATH = require.resolve('ws');
let originalWsCacheEntry;

function installFakeWs() {
  FakeWebSocket.instances = [];
  originalWsCacheEntry = require.cache[WS_PATH];
  require.cache[WS_PATH] = { id: WS_PATH, filename: WS_PATH, loaded: true, exports: FakeWebSocket };
}

function restoreWs() {
  if (originalWsCacheEntry) {
    require.cache[WS_PATH] = originalWsCacheEntry;
  } else {
    delete require.cache[WS_PATH];
  }
}

function sarvamConfig(overrides = {}) {
  return {
    model: 'saaras:v3',
    language: 'hi-IN',
    mode: 'transcription',
    api_key_env: 'TEST_SARVAM_KEY',
    sample_rate: 16000,
    high_vad_sensitivity: false,
    ...overrides,
  };
}

function sampleRateFromWav(base64Wav) {
  const wav = Buffer.from(base64Wav, 'base64');
  return wav.readUInt32LE(24); // WAV header sample-rate field, see utils/audio.js pcmToWav
}

function makeChunk(frames = 4) {
  return Buffer.alloc(frames * 2); // 16-bit mono PCM, silence is fine — only the rate matters
}

describe('SarvamSTTAdapter — announced sample rate is authoritative', () => {
  beforeEach(installFakeWs);
  afterEach(restoreWs);

  test('uses the transport-announced rate (8000), not the configured default (16000)', async () => {
    const adapter = new SarvamSTTAdapter();
    await adapter.init(sarvamConfig(), { TEST_SARVAM_KEY: 'secret' });

    await adapter.transcribe(makeChunk(), () => {}, { channels: 1, sampleRate: 8000 });

    assert.strictEqual(FakeWebSocket.instances.length, 1);
    const connectUrl = FakeWebSocket.instances[0].url;
    assert.match(connectUrl, /sample_rate=8000/, `connect URL should carry 8000: ${connectUrl}`);

    const sent = JSON.parse(FakeWebSocket.instances[0].sent[0]);
    assert.strictEqual(sent.audio.sample_rate, 8000);
    assert.strictEqual(
      sampleRateFromWav(sent.audio.data),
      8000,
      'WAV header bytes must carry the corrected rate, not an intermediate variable'
    );

    await adapter.dispose();
  });

  test('falls back to the configured rate when the transport announces nothing', async () => {
    const adapter = new SarvamSTTAdapter();
    await adapter.init(sarvamConfig({ sample_rate: 16000 }), { TEST_SARVAM_KEY: 'secret' });

    await adapter.transcribe(makeChunk(), () => {}, { channels: 1 });

    const connectUrl = FakeWebSocket.instances[0].url;
    assert.match(connectUrl, /sample_rate=16000/);

    const sent = JSON.parse(FakeWebSocket.instances[0].sent[0]);
    assert.strictEqual(sent.audio.sample_rate, 16000);
    assert.strictEqual(sampleRateFromWav(sent.audio.data), 16000);

    await adapter.dispose();
  });

  test('two concurrent streams announcing different rates do not corrupt each other', async () => {
    // Mirrors production: ProviderRegistry.getActiveSTT() hands each WS
    // connection its own adapter instance. Verify that holds up — one
    // instance's announced rate must never leak into another's.
    const adapterA = new SarvamSTTAdapter();
    const adapterB = new SarvamSTTAdapter();
    await adapterA.init(sarvamConfig(), { TEST_SARVAM_KEY: 'secret' });
    await adapterB.init(sarvamConfig(), { TEST_SARVAM_KEY: 'secret' });

    await Promise.all([
      adapterA.transcribe(makeChunk(), () => {}, { channels: 1, sampleRate: 8000 }),
      adapterB.transcribe(makeChunk(), () => {}, { channels: 1, sampleRate: 48000 }),
    ]);

    assert.strictEqual(FakeWebSocket.instances.length, 2);
    const urls = FakeWebSocket.instances.map((ws) => ws.url);
    assert.ok(urls.some((u) => /sample_rate=8000/.test(u)));
    assert.ok(urls.some((u) => /sample_rate=48000/.test(u)));

    const sentA = JSON.parse(FakeWebSocket.instances.find((w) => /sample_rate=8000/.test(w.url)).sent[0]);
    const sentB = JSON.parse(FakeWebSocket.instances.find((w) => /sample_rate=48000/.test(w.url)).sent[0]);
    assert.strictEqual(sampleRateFromWav(sentA.audio.data), 8000);
    assert.strictEqual(sampleRateFromWav(sentB.audio.data), 48000);

    await adapterA.dispose();
    await adapterB.dispose();
  });
});

// ---------------------------------------------------------------------------
// vapi.js — the STT WebSocket route must read the announced sampleRate off
// the 'start' message and pass it through transcribe() opts, exactly as it
// already does for channels.
// ---------------------------------------------------------------------------

/** A fake client-facing ws (Vapi's side), collecting handlers registered on it. */
function fakeClientWs() {
  const handlers = {};
  return {
    readyState: 1,
    on(event, cb) {
      handlers[event] = cb;
    },
    emit(event, ...args) {
      if (handlers[event]) handlers[event](...args);
    },
    send() {},
  };
}

/** A fake STT adapter that records every transcribe() opts object it receives. */
function fakeSttAdapter() {
  return {
    calls: [],
    async init() {},
    async transcribe(data, cb, opts) {
      this.calls.push(opts);
    },
    async dispose() {},
  };
}

async function startVapiSttRoute({ configuredSampleRate = 16000 } = {}) {
  const sttAdapter = fakeSttAdapter();
  const registry = {
    isBridged: () => true,
    getActiveSTT: () => sttAdapter,
    getSTTConfig: () => ({ sample_rate: configuredSampleRate }),
    getActiveProviderNames: () => ({ stt: 'sarvam' }),
  };
  const transport = new VapiTransportAdapter(registry);

  let connectionHandler;
  const wss = {
    on(event, handler) {
      if (event === 'connection') connectionHandler = handler;
    },
  };
  const app = { post() {} };

  await transport.start(null, { getEventBus: () => ({ emit: async () => {} }) }, {
    wss,
    app,
    providersConfig: {},
    strategy: {},
    repository: {},
    webhookUrl: 'http://localhost:3001',
  });

  const ws = fakeClientWs();
  await connectionHandler(ws, { url: '/api/stt' });
  // sttAdapter.init() runs inside the async connection handler before any
  // listeners are attached synchronously — give it a tick to settle.
  await new Promise((resolve) => setImmediate(resolve));

  return { ws, sttAdapter };
}

describe('VapiTransportAdapter /api/stt — announced sampleRate reaches the STT adapter', () => {
  test('passes the announced sampleRate through to transcribe() opts', async () => {
    const { ws, sttAdapter } = await startVapiSttRoute({ configuredSampleRate: 16000 });

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', channels: 1, sampleRate: 8000 })), false);
    await ws.emit('message', Buffer.alloc(4), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(sttAdapter.calls.length, 1);
    assert.strictEqual(sttAdapter.calls[0].sampleRate, 8000);
  });

  test('when the transport announces nothing, opts carries no override (adapter falls back to config)', async () => {
    const { ws, sttAdapter } = await startVapiSttRoute({ configuredSampleRate: 16000 });

    await ws.emit('message', Buffer.alloc(4), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(sttAdapter.calls.length, 1);
    assert.ok(
      sttAdapter.calls[0].sampleRate === undefined || sttAdapter.calls[0].sampleRate === null,
      `expected no announced rate, got ${sttAdapter.calls[0].sampleRate}`
    );
  });

  test('two concurrent connections keep independent announced rates (no shared module state)', async () => {
    const { ws: wsA, sttAdapter: adapterA } = await startVapiSttRoute({ configuredSampleRate: 16000 });
    const { ws: wsB, sttAdapter: adapterB } = await startVapiSttRoute({ configuredSampleRate: 16000 });

    wsA.emit('message', Buffer.from(JSON.stringify({ type: 'start', channels: 1, sampleRate: 8000 })), false);
    wsB.emit('message', Buffer.from(JSON.stringify({ type: 'start', channels: 1, sampleRate: 44100 })), false);

    await wsA.emit('message', Buffer.alloc(4), true);
    await wsB.emit('message', Buffer.alloc(4), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(adapterA.calls[0].sampleRate, 8000);
    assert.strictEqual(adapterB.calls[0].sampleRate, 44100);
  });

  test('the mismatch log reports the rate was corrected, not that transcripts will be bad', async () => {
    const originalLog = logger.log;
    const logs = [];
    logger.log = (event, data) => logs.push({ event, data });
    try {
      const { ws } = await startVapiSttRoute({ configuredSampleRate: 16000 });
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', channels: 1, sampleRate: 8000 })), false);
    } finally {
      logger.log = originalLog;
    }

    const mismatchLog = logs.find((l) => l.event.includes('sample_rate'));
    assert.ok(mismatchLog, 'expected a sample-rate log line');
    const serialized = JSON.stringify(mismatchLog.data);
    assert.ok(
      !/expect empty or garbled transcripts/.test(serialized),
      'log should no longer claim transcripts will be bad — the rate is now corrected'
    );
  });
});
