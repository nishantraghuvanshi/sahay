'use strict';

/**
 * Confirms each LLM streaming adapter (openai, sarvam, groq) actually wires
 * up fetchWithStreamTimeout — not just that the shared helper works in
 * isolation (see stream-timeout.test.js). Each adapter's chatCompletionStream
 * receives a `config` object per call, so the timeout overrides here are
 * injected directly rather than touching config/providers.yaml.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SarvamLLMAdapter = require('../src/adapters/providers/llm/sarvam');
const OpenAILLMAdapter = require('../src/adapters/providers/llm/openai');
const GroqLLMAdapter = require('../src/adapters/providers/llm/groq');

const adapters = [
  {
    name: 'sarvam',
    Adapter: SarvamLLMAdapter,
    config: {
      base_url: 'https://example.test/sarvam',
      model: 'sarvam-105b-conversations',
      api_key_env: 'FAKE_SARVAM_KEY',
    },
  },
  {
    name: 'openai',
    Adapter: OpenAILLMAdapter,
    config: {
      base_url: 'https://example.test/openai',
      model: 'gpt-5-nano',
      api_key_env: 'FAKE_OPENAI_KEY',
    },
  },
  {
    name: 'groq',
    Adapter: GroqLLMAdapter,
    config: {
      base_url: 'https://example.test/groq',
      model: 'llama-3.3-70b-versatile',
      api_key_env: 'FAKE_GROQ_KEY',
    },
  },
];

describe('LLM adapter chatCompletionStream idle/first-chunk timeout wiring', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  for (const { name, Adapter, config } of adapters) {
    it(`${name}: aborts and throws naming the provider when the stream never sends a first chunk`, async () => {
      global.fetch = async (url, options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          // fetch() itself hangs — the connect/first-byte timeout must fire.
        });

      const adapter = new Adapter();
      const env = { [config.api_key_env]: 'test-key' };
      const streamConfig = {
        ...config,
        stream_first_chunk_timeout_ms: 20,
        stream_idle_timeout_ms: 1000,
      };

      await assert.rejects(
        adapter.chatCompletionStream({ messages: [] }, streamConfig, env, () => {}),
        (err) => {
          assert.match(err.message, new RegExp(name, 'i'));
          return true;
        }
      );
    });

    it(`${name}: a normal completed stream still returns assembled content`, async () => {
      const encoder = new TextEncoder();
      global.fetch = async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      };

      const adapter = new Adapter();
      const env = { [config.api_key_env]: 'test-key' };
      const streamConfig = {
        ...config,
        stream_first_chunk_timeout_ms: 1000,
        stream_idle_timeout_ms: 1000,
      };

      const tokens = [];
      const result = await adapter.chatCompletionStream(
        { messages: [] },
        streamConfig,
        env,
        (t) => tokens.push(t)
      );

      assert.equal(result.content, 'hi');
      assert.deepEqual(tokens, ['hi']);
    });
  }
});
