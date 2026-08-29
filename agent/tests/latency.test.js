'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { TurnLatency } = require('../src/utils/latency');

describe('TurnLatency', () => {
  test('records the three moments as deltas from turn start', () => {
    let now = 1000;
    const emitted = [];
    const t = new TurnLatency({ callId: 'c1', turnIndex: 3, clock: () => now, emit: (m) => emitted.push(m) });

    now = 1120; t.llmFirstToken();
    now = 1450; t.ttsFirstAudio();
    now = 1900; t.turnComplete();

    assert.strictEqual(emitted.length, 1);
    const m = emitted[0];
    assert.strictEqual(m.callId, 'c1');
    assert.strictEqual(m.turnIndex, 3);
    assert.strictEqual(m.llmFirstTokenMs, 120);
    assert.strictEqual(m.ttsFirstAudioMs, 450);
    assert.strictEqual(m.turnTotalMs, 900);
  });

  test('only the FIRST token and FIRST audio chunk are recorded', () => {
    let now = 0;
    const emitted = [];
    const t = new TurnLatency({ callId: 'c2', clock: () => now, emit: (m) => emitted.push(m) });

    now = 50; t.llmFirstToken();
    now = 80; t.llmFirstToken();
    now = 200; t.ttsFirstAudio();
    now = 260; t.ttsFirstAudio();
    now = 300; t.turnComplete();

    assert.strictEqual(emitted[0].llmFirstTokenMs, 50);
    assert.strictEqual(emitted[0].ttsFirstAudioMs, 200);
  });

  test('a turn that never produced audio still emits, with null', () => {
    let now = 0;
    const emitted = [];
    const t = new TurnLatency({ callId: 'c3', clock: () => now, emit: (m) => emitted.push(m) });

    now = 90; t.llmFirstToken();
    now = 400; t.turnComplete();

    assert.strictEqual(emitted[0].ttsFirstAudioMs, null);
    assert.strictEqual(emitted[0].llmFirstTokenMs, 90);
  });

  test('turnComplete is idempotent — no duplicate metrics', () => {
    let now = 0;
    const emitted = [];
    const t = new TurnLatency({ callId: 'c4', clock: () => now, emit: (m) => emitted.push(m) });

    now = 100; t.turnComplete();
    now = 200; t.turnComplete();

    assert.strictEqual(emitted.length, 1);
  });
});
