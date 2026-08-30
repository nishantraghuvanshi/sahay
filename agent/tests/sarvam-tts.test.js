'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const SarvamTTSAdapter = require('../src/adapters/providers/tts/sarvam');

/**
 * Fake Sarvam WebSocket. Sarvam's protocol has no request id on its audio
 * messages, so this replies to each 'text' send with a distinguishable
 * chunk on a later tick, then a 'final' after the matching 'flush' — close
 * enough to the real timing to expose cross-delivery if sendText() doesn't
 * scope its listeners per call.
 */
function makeFakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  let pendingText = null;
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'text') {
      pendingText = msg.data.text;
      setImmediate(() => {
        const audio = Buffer.from(`chunk-for-${pendingText}`).toString('base64');
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'audio', data: { audio } })));
      });
    } else if (msg.type === 'flush') {
      setImmediate(() => ws.emit('message', Buffer.from(JSON.stringify({ type: 'final' }))));
    }
  };
  return ws;
}

describe('SarvamTTSAdapter.sendText', () => {
  test('two concurrent calls each receive only their own audio chunks', async () => {
    const adapter = new SarvamTTSAdapter();
    adapter._ws = makeFakeSocket();

    const chunksA = [];
    const chunksB = [];

    const pA = adapter.sendText('first sentence', (buf) => chunksA.push(buf.toString()));
    const pB = adapter.sendText('second sentence', (buf) => chunksB.push(buf.toString()));

    await Promise.all([pA, pB]);

    assert.deepStrictEqual(chunksA, ['chunk-for-first sentence']);
    assert.deepStrictEqual(chunksB, ['chunk-for-second sentence']);
  });

  test('rejects when the socket is not connected', async () => {
    const adapter = new SarvamTTSAdapter();
    await assert.rejects(() => adapter.sendText('hi', () => {}), /not connected/);
  });
});
