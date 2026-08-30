'use strict';

const logger = require('./logger');

/**
 * Stream Timeout Utility
 *
 * The three LLM streaming adapters (openai.js, sarvam.js, groq.js) each call
 * fetch() with no timeout at all on the streaming path — only their blocking
 * chatCompletion() has one (see retry.js). If a provider accepts the
 * connection and then goes quiet, no error ever fires and the turn hangs
 * forever: on a phone call, that is silence with no recovery.
 *
 * Two separate timeouts, not one:
 *   - firstChunkTimeoutMs bounds connecting AND waiting for the first byte
 *     of the stream. A provider that never responds at all should fail fast.
 *   - idleTimeoutMs bounds the gap between subsequent chunks, and RESETS on
 *     every chunk received. A long legitimate answer must never be killed
 *     mid-sentence — only a stream that has gone silent should be.
 *
 * fetchWithStreamTimeout() wraps fetch() and returns a response whose body
 * is a ReadableStream enforcing both timeouts transparently, so callers
 * (parseSSEStream) don't need to know timeouts exist. On timeout it aborts
 * the underlying fetch via AbortController and the wrapped stream errors
 * with a distinguishable, named error — never a silent partial result.
 */

const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 20000;

/**
 * Build the timeout error for a stalled stream, logging a distinct event
 * before it is thrown so a stall is never silent.
 * @private
 */
function _streamTimeoutError(provider, stage, timeoutMs) {
  const waitingFor = stage === 'first-chunk' ? 'the first chunk' : 'the next chunk';
  const err = new Error(
    `${provider} LLM stream timed out waiting for ${waitingFor} after ${timeoutMs}ms`
  );
  err.name = 'StreamTimeoutError';
  err.provider = provider;
  err.stage = stage;
  logger.log(`llm_${provider}_stream_timeout`, { stage, timeoutMs });
  return err;
}

/**
 * Race a promise against a deadline. If the deadline wins, abort
 * `controller` and reject with a stream timeout error naming `provider`
 * and `stage`. Either way, the timer is cleared.
 * @private
 */
function _withDeadline(promise, timeoutMs, { provider, stage, controller }) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(_streamTimeoutError(provider, stage, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * fetch() a streaming LLM endpoint with a first-chunk timeout and a
 * resetting idle timeout between chunks.
 *
 * @param {string} url
 * @param {Object} fetchOptions - passed through to fetch(); .signal is owned
 *   by this helper and must not be set by the caller.
 * @param {Object} opts
 * @param {string} opts.provider - name used in log events and error messages
 * @param {number} [opts.firstChunkTimeoutMs]
 * @param {number} [opts.idleTimeoutMs]
 * @returns {Promise<{ok: boolean, status: number, body: ReadableStream|null}|Response>}
 *   The original response when !ok or bodyless (nothing to wrap); otherwise
 *   a minimal response-shaped object whose .body enforces the timeouts.
 */
async function fetchWithStreamTimeout(
  url,
  fetchOptions,
  {
    provider,
    firstChunkTimeoutMs = DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  }
) {
  const controller = new AbortController();

  const response = await _withDeadline(
    fetch(url, { ...fetchOptions, signal: controller.signal }),
    firstChunkTimeoutMs,
    { provider, stage: 'first-chunk', controller }
  );

  if (!response.ok || !response.body) {
    return response;
  }

  const upstreamReader = response.body.getReader();
  let firstChunkReceived = false;

  const wrappedBody = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await _withDeadline(
          upstreamReader.read(),
          firstChunkReceived ? idleTimeoutMs : firstChunkTimeoutMs,
          { provider, stage: firstChunkReceived ? 'idle' : 'first-chunk', controller }
        );

        if (done) {
          ctrl.close();
          return;
        }

        firstChunkReceived = true;
        ctrl.enqueue(value);
      } catch (err) {
        ctrl.error(err);
      }
    },
    cancel(reason) {
      return upstreamReader.cancel(reason);
    },
  });

  return { ok: response.ok, status: response.status, body: wrappedBody };
}

module.exports = {
  fetchWithStreamTimeout,
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
};
