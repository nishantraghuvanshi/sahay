'use strict';

/**
 * LLM Port (interface)
 *
 * Handles chat completion requests. Implementations are adapters for
 * specific providers (Sarvam, Groq, OpenAI, etc.).
 *
 * Both blocking and streaming modes are supported. Streaming delivers
 * tokens via SSE (server-sent events) for lower time-to-first-token.
 */
class LLMPort {
  /**
   * Forward a chat completion request to the LLM provider (blocking).
   * @param {Object} body - OpenAI-compatible request body
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @returns {Object} OpenAI-compatible response
   */
  async chatCompletion(body, config, env) {
    throw new Error('LLMPort.chatCompletion() not implemented');
  }

  /**
   * Stream a chat completion request via SSE.
   *
   * Calls onToken(text) for each content delta as it arrives.
   * Returns the full assembled response (text + tool_calls) when done.
   *
   * @param {Object} body - OpenAI-compatible request body
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @param {Function} onToken - (textDelta) => void, called for each token
   * @returns {Object} Assembled response: { content: string, tool_calls: Array|null }
   */
  async chatCompletionStream(body, config, env, onToken) {
    throw new Error('LLMPort.chatCompletionStream() not implemented');
  }
}

module.exports = LLMPort;
