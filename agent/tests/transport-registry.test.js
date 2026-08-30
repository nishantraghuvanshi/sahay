'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const TransportRegistry = require('../src/adapters/transport/registry');
const TransportPort = require('../src/core/ports/transport');
const ProviderRegistry = require('../src/adapters/providers/registry');
const VapiTransportAdapter = require('../src/adapters/transport/vapi');

/**
 * Transport registry tests.
 *
 * The TransportPort interface always named Vapi, LiveKit and Pipecat as peers,
 * but server.js constructed VapiTransportAdapter directly — so the orchestrator
 * was the one thing in this codebase that could not be swapped from config.
 * These tests pin the seam open.
 */

describe('TransportRegistry', () => {
  test('getActiveTransport returns an adapter implementing TransportPort', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    const transport = reg.getActiveTransport();
    assert.ok(transport instanceof TransportPort);
  });

  test('the returned adapter implements the whole port surface', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    const transport = reg.getActiveTransport();
    for (const method of ['start', 'buildAssistantConfig', 'createCall']) {
      assert.strictEqual(
        typeof transport[method],
        'function',
        `transport should implement ${method}()`
      );
    }
  });

  test('getActiveTransportName reflects config, not a hardcoded string', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    const config = require('../src/core/config/loader').loadProvidersConfig();
    assert.strictEqual(reg.getActiveTransportName(), config.active.transport);
  });

  test('vapi is registered', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    assert.ok(reg.getAvailableTransports().includes('vapi'));
  });

  test('unknown transport throws an error listing what is available', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    assert.throws(
      () => reg.getTransport('livekit'),
      /Unknown transport: "livekit".*Available/s
    );
  });

  test('getTransportConfig returns the active transport config block', () => {
    const reg = new TransportRegistry(new ProviderRegistry());
    assert.ok(reg.getTransportConfig(), 'active transport should have a config block');
  });

  test('TRANSPORT env var overrides active.transport from the YAML', () => {
    const previous = process.env.TRANSPORT;
    process.env.TRANSPORT = 'vapi';
    try {
      const reg = new TransportRegistry(new ProviderRegistry());
      assert.strictEqual(reg.getActiveTransportName(), 'vapi');
      assert.ok(reg.getActiveTransport() instanceof VapiTransportAdapter);
    } finally {
      if (previous === undefined) {
        delete process.env.TRANSPORT;
      } else {
        process.env.TRANSPORT = previous;
      }
    }
  });
});
