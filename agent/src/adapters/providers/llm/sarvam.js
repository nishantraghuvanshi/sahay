'use strict';

const LLMPort = require('../../../core/ports/llm');
const logger = require('../../../utils/logger');
const { withRetry, isRetryableHttpError } = require('../../../utils/retry');
const { parseSSEStream } = require('../../../utils/sse');
const {
  fetchWithStreamTimeout,
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} = require('../../../utils/stream-timeout');

/**
 * Sarvam LLM Adapter
 *
 * Forwards OpenAI-compatible chat completion requests to the Sarvam API.
 * Sarvam's API is OpenAI-compatible, so this is a transparent proxy that
 * injects the API key and overrides model/temperature/max_tokens from config.
 *
 * reasoning_effort is sent only when configured. The API accepts 'low',
 * 'medium' or 'high' and rejects 'none' with a 400 — thinking is disabled by
 * omitting the field, not by naming it. Leaving it unset also avoids the
 * empty-reply failure where reasoning consumes the whole max_tokens budget.
 *
 * Supports both blocking (chatCompletion) and streaming (chatCompletionStream)
 * modes. Streaming uses SSE for lower time-to-first-token.
 *
 * Includes timeout (15s) and retry (2 attempts) for transient failures.
 */
class SarvamLLMAdapter extends LLMPort {
  /**
   * Forward a chat completion request to Sarvam's API (blocking).
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

    const requestBody = {
      ...body,
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      // reasoning_effort is sent ONLY when configured. The API accepts
      // 'low' | 'medium' | 'high' and rejects the string 'none' outright
      // (400: "Input should be 'low', 'medium' or 'high'"), so the previous
      // default made every request fail. Omitting it is how thinking is
      // disabled — and on sarvam-105b even 'low' consumed the whole budget
      // and returned content: null, which is silence on a phone call.
      ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
    };

    return withRetry(
      async (signal) => {
        const response = await fetch(`${config.base_url}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'API-Subscription-Key': apiKey,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`Sarvam LLM error (${response.status}): ${errorText}`);
          err.status = response.status;
          logger.error('llm_sarvam_error', err, { status: response.status });
          throw err;
        }

        return await response.json();
      },
      {
        maxRetries: 2,
        timeoutMs: 15000,
        onRetry: (err, attempt, delayMs) => {
          logger.log('llm_sarvam_retry', { attempt, delayMs, error: err.message });
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

    const requestBody = {
      ...body,
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      // Same rule as the blocking path above: only send reasoning_effort when
      // it is configured. 'none' is rejected with a 400.
      ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
      stream: true,
    };

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
          'API-Subscription-Key': apiKey,
        },
        body: JSON.stringify(requestBody),
      },
      {
        provider: 'sarvam',
        firstChunkTimeoutMs: config.stream_first_chunk_timeout_ms ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
        idleTimeoutMs: config.stream_idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`Sarvam LLM stream error (${response.status}): ${errorText}`);
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

module.exports = SarvamLLMAdapter;
