'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const STTPort = require('../src/core/ports/stt');
const LLMPort = require('../src/core/ports/llm');
const TTSPort = require('../src/core/ports/tts');
const TransportPort = require('../src/core/ports/transport');
const OutcomeRepositoryPort = require('../src/core/ports/repository');

describe('STTPort', () => {
  test('init throws not-implemented', async () => {
    const port = new STTPort();
    await assert.rejects(() => port.init({}, {}), /not implemented/);
  });

  test('transcribe throws not-implemented', async () => {
    const port = new STTPort();
    await assert.rejects(() => port.transcribe(Buffer.alloc(0), () => {}), /not implemented/);
  });

  test('dispose throws not-implemented', async () => {
    const port = new STTPort();
    await assert.rejects(() => port.dispose(), /not implemented/);
  });
});

describe('LLMPort', () => {
  test('chatCompletion throws not-implemented', async () => {
    const port = new LLMPort();
    await assert.rejects(() => port.chatCompletion({}, {}, {}), /not implemented/);
  });
});

describe('TTSPort', () => {
  test('synthesize throws not-implemented', async () => {
    const port = new TTSPort();
    await assert.rejects(() => port.synthesize({}, {}, {}), /not implemented/);
  });
});

describe('TransportPort', () => {
  test('start throws not-implemented', async () => {
    const port = new TransportPort();
    await assert.rejects(() => port.start({}, {}, {}), /not implemented/);
  });

  test('buildAssistantConfig throws not-implemented', () => {
    const port = new TransportPort();
    assert.throws(() => port.buildAssistantConfig({}, {}, ''), /not implemented/);
  });

  test('createCall throws not-implemented', async () => {
    const port = new TransportPort();
    await assert.rejects(() => port.createCall('', '', {}), /not implemented/);
  });
});

describe('OutcomeRepositoryPort', () => {
  test('save throws not-implemented', async () => {
    const port = new OutcomeRepositoryPort();
    await assert.rejects(() => port.save({}), /not implemented/);
  });

  test('list throws not-implemented', async () => {
    const port = new OutcomeRepositoryPort();
    await assert.rejects(() => port.list({}), /not implemented/);
  });
});
