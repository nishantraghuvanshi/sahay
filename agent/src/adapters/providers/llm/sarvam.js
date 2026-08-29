'use strict';

const LLMPort = require('../../../core/ports/llm');
const logger = require('../../../utils/logger');
const { withRetry, isRetryableHttpError } = require('../../../utils/retry');
const { parseSSEStream } = require('../../../utils/sse');

/**
 * Sarvam LLM Adapter
 *
 * Forwards OpenAI-compatible chat completion requests to the Sarvam API.
 * Sarvam's API is OpenAI-compatible, so this is a transparent proxy that
 * injects the API key and overrides model/temperature/max_tokens from config.
 *
 * Sets reasoning_effort to "none" to disable thinking mode, which avoids
 * empty replies (reasoning can consume the max_tokens budget).
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
      reasoning_effort: body.reasoning_effort || 'none',
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
      reasoning_effort: body.reasoning_effort || 'none',
      stream: true,
    };

    const response = await fetch(`${config.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'API-Subscription-Key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

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
