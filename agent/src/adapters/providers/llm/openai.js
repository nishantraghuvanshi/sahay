'use strict';

const LLMPort = require('../../../core/ports/llm');
const logger = require('../../../utils/logger');
const { withRetry } = require('../../../utils/retry');
const { parseSSEStream } = require('../../../utils/sse');

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

    const requestBody = {
      ...body,
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
    };

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

    const requestBody = {
      ...body,
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      stream: true,
    };

    const response = await fetch(`${config.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

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
