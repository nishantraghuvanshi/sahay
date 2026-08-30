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

  test('requiredSecrets throws not-implemented — no silent "needs nothing" default', () => {
    const port = new TransportPort();
    assert.throws(() => port.requiredSecrets(), /not implemented/);
  });

  test('every registered transport adapter implements requiredSecrets()', () => {
    const { TRANSPORT_ADAPTERS } = require('../src/adapters/transport/registry');
    for (const [name, AdapterClass] of Object.entries(TRANSPORT_ADAPTERS)) {
      const adapter = new AdapterClass({}, {});
      assert.doesNotThrow(
        () => adapter.requiredSecrets(),
        `${name} transport must override requiredSecrets()`
      );
      assert.ok(
        Array.isArray(adapter.requiredSecrets()),
        `${name} transport's requiredSecrets() must return an array`
      );
    }
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

  // src/core/call/lifecycle.js is the transport-agnostic state machine every
  // orchestrator shares; it calls these methods directly on whatever
  // repository is wired in. If the port stops declaring one, a new adapter
  // can satisfy the interface and still crash the first real call.
  const LIFECYCLE_METHODS = [
    'createCall',
    'createSession',
    'getSession',
    'updateSessionFields',
    'endSession',
    'saveMessage',
    'findPatientByPhone',
  ];

  for (const method of LIFECYCLE_METHODS) {
    test(`declares ${method} (required by call/lifecycle.js)`, () => {
      assert.strictEqual(typeof OutcomeRepositoryPort.prototype[method], 'function');
    });
  }

  test('both real repository adapters implement every method the port declares', () => {
    const ConsoleRepository = require('../src/adapters/persistence/console');
    const SqliteRepository = require('../src/adapters/persistence/sqlite');

    const portMethods = Object.getOwnPropertyNames(OutcomeRepositoryPort.prototype)
      .filter((name) => {
        if (name === 'constructor') return false;
        const descriptor = Object.getOwnPropertyDescriptor(OutcomeRepositoryPort.prototype, name);
        return typeof descriptor.value === 'function';
      });

    const consoleRepo = new ConsoleRepository();
    const sqliteRepo = new SqliteRepository({ dbPath: ':memory:' });
    try {
      for (const method of portMethods) {
        assert.strictEqual(typeof consoleRepo[method], 'function', `ConsoleRepository missing ${method}`);
        assert.strictEqual(typeof sqliteRepo[method], 'function', `SqliteRepository missing ${method}`);
      }
    } finally {
      sqliteRepo.close();
    }
  });
});
