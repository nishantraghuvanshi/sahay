'use strict';

const LLMPort = require('../../../core/ports/llm');
const logger = require('../../../utils/logger');
const { withRetry } = require('../../../utils/retry');
const { parseSSEStream } = require('../../../utils/sse');
const {
  fetchWithStreamTimeout,
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} = require('../../../utils/stream-timeout');


/**
 * Shape the OpenAI request body from provider config.
 *
 * Two model families need different dialects of the same API, so every
 * parameter here is opt-in from providers.yaml rather than hardcoded:
 *
 *   - Older chat models (gpt-4o-mini and friends) take `temperature` and
 *     `max_tokens`.
 *   - Reasoning models (the gpt-5 / o-series family) REJECT `max_tokens`
 *     outright, accept only the default temperature, and take
 *     `max_completion_tokens`.
 *
 * `reasoning_effort` matters more than it looks. Left unset, a reasoning model
 * spends its entire completion budget thinking and returns content: "" — a
 * caller hears silence, the call logs look healthy, and nothing errors. On a
 * voice call that is both a correctness bug and a latency bug, so the config
 * sets it to "minimal".
 *
 * A key absent from config is simply not sent, which is what lets one adapter
 * serve both families without sniffing model-name prefixes.
 */
function buildRequestBody(body, config, extra = {}) {
  const requestBody = { ...body, model: config.model, ...extra };

  if (config.temperature != null) requestBody.temperature = config.temperature;
  if (config.max_tokens != null) requestBody.max_tokens = config.max_tokens;
  if (config.max_completion_tokens != null) {
    requestBody.max_completion_tokens = config.max_completion_tokens;
  }
  if (config.reasoning_effort != null) {
    requestBody.reasoning_effort = config.reasoning_effort;
  }

  return requestBody;
}

/**
 * OpenAI LLM Adapter
 *
 * Forwards OpenAI-compatible chat completion requests to the OpenAI API,
 * injecting the API key and overriding model/temperature/max_tokens from config.
 *
 * Exists as a bridge provider rather than a native Vapi one so the LLM can be
 * A/B'd against Sarvam and Groq from providers.yaml alone. Going native would
 * be lower latency but would remove the swap point entirely.
 *
 * Supports both blocking (chatCompletion) and streaming (chatCompletionStream)
 * modes. Streaming uses SSE for lower time-to-first-token.
 *
 * Includes timeout (15s) and retry (2 attempts) for transient failures.
 */
class OpenAILLMAdapter extends LLMPort {
  /**
   * Forward a chat completion request to OpenAI's API (blocking).
   * @param {Object} body - OpenAI-compatible request body
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @returns {Object} OpenAI-compatible response
   */
  async chatCompletion(body, config, env) {
    const apiKey = env[config.api_key_env];
    if (!apiKey) {
      throw new Error(`Missing env var: ${config.api_key_env}`);
    }

    const requestBody = buildRequestBody(body, config);

    return withRetry(
      async (signal) => {
        const response = await fetch(`${config.base_url}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`OpenAI LLM error (${response.status}): ${errorText}`);
          err.status = response.status;
          logger.error('llm_openai_error', err, { status: response.status });
          throw err;
        }

        return await response.json();
      },
      {
        maxRetries: 2,
        timeoutMs: 15000,
        onRetry: (err, attempt, delayMs) => {
          logger.log('llm_openai_retry', { attempt, delayMs, error: err.message });
        },
      }
    );
  }

  /**
   * Stream a chat completion request via SSE.
   *
   * Calls onToken(text) for each content delta as it arrives.
   * Returns the assembled response when the stream completes.
   *
   * @param {Object} body - OpenAI-compatible request body
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @param {Function} onToken - (textDelta) => void
   * @returns {Object} { content: string, tool_calls: Array|null }
   */
  async chatCompletionStream(body, config, env, onToken) {
    const apiKey = env[config.api_key_env];
    if (!apiKey) {
      throw new Error(`Missing env var: ${config.api_key_env}`);
    }

    const requestBody = buildRequestBody(body, config, { stream: true });

    // A stalled stream (connection accepted, then silence — no error, no
    // close) would otherwise hang the turn forever. fetchWithStreamTimeout
    // aborts if the first chunk never arrives, and separately if any later
    // chunk takes too long, without capping the length of a normal answer.
    const response = await fetchWithStreamTimeout(
      `${config.base_url}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      {
        provider: 'openai',
        firstChunkTimeoutMs: config.stream_first_chunk_timeout_ms ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
        idleTimeoutMs: config.stream_idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`OpenAI LLM stream error (${response.status}): ${errorText}`);
      err.status = response.status;
      throw err;
    }

    let content = '';
    let toolCalls = null;

    await parseSSEStream(response, (delta) => {
      if (delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }
      if (delta.tool_calls) {
        toolCalls = toolCalls || [];
        for (const tc of delta.tool_calls) {
          _mergeToolCallDelta(toolCalls, tc);
        }
      }
    });

    return { content: content || null, tool_calls: toolCalls };
  }
}

/**
 * Merge a streaming tool call delta into the accumulated array.
 * @private
 */
function _mergeToolCallDelta(accumulated, delta) {
  const index = delta.index ?? 0;
  if (!accumulated[index]) {
    accumulated[index] = {
      id: delta.id || '',
      type: 'function',
      function: { name: '', arguments: '' },
    };
  }
  if (delta.function?.name) {
    accumulated[index].function.name += delta.function.name;
  }
  if (delta.function?.arguments) {
    accumulated[index].function.arguments += delta.function.arguments;
  }
}

module.exports = OpenAILLMAdapter;
