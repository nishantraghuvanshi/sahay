'use strict';

/**
 * Retry & Timeout Utilities
 *
 * Shared helpers for resilient HTTP and WebSocket calls across adapters.
 * Provides:
 *   - withRetry() — exponential backoff with jitter, timeout via AbortController,
 *     and a predicate to decide which errors are retryable.
 *   - isRetryableHttpError() — true for network errors, timeouts, and 5xx.
 *   - sleep() — promise-based delay.
 */

/**
 * Promise-based delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if an error is worth retrying for HTTP-based calls.
 *
 * Retryable: network errors (TypeError from fetch), AbortError (timeout),
 * and HTTP 5xx responses (wrapped in an object with .status).
 *
 * Not retryable: 4xx errors, 401/403 auth errors, and other client errors.
 *
 * @param {Error|Object} err
 * @returns {boolean}
 */
function isRetryableHttpError(err) {
  // Network failure — fetch throws a TypeError.
  if (err instanceof TypeError) return true;

  // Timeout via AbortController.
  if (err.name === 'AbortError') return true;

  // HTTP status errors — our adapters throw Error objects with the status
  // embedded in the message like "Sarvam LLM error (503): ...".
  // Also handle a structured { status } property if present.
  const status = err.status || _extractStatusFromMessage(err.message);
  if (status !== undefined) {
    return status >= 500 || status === 408 || status === 429;
  }

  // Unknown error — don't retry to avoid infinite loops.
  return false;
}

/**
 * Extract the HTTP status code from an error message like
 * "Sarvam LLM error (503): ...".
 * @private
 */
function _extractStatusFromMessage(message) {
  if (!message) return undefined;
  const match = message.match(/\((\d{3})\)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Execute an async function with a timeout.
 *
 * Wraps the function in a Promise.race against the AbortController timer.
 * When the timeout fires, the controller is aborted (which cancels in-flight
 * fetch() calls) AND a timeout rejection wins the race — so even functions
 * that don't check the signal will be terminated.
 *
 * @param {Function} fn - async function that receives an AbortSignal
 * @param {number} timeoutMs
 * @returns {Promise<*>} The result of fn
 * @throws {Error} AbortError if the timeout fires
 */
async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          const err = new Error(`Operation timed out after ${timeoutMs}ms`);
          err.name = 'AbortError';
          reject(err);
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute an async function with retry, timeout, and exponential backoff.
 *
 * The function receives an AbortSignal it can pass to fetch() for timeout
 * cancellation. Retries only happen for errors where retryOn(err) returns true.
 *
 * @param {Function} fn - async (signal) => result
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=2] - Max retry attempts after the first try
 * @param {number} [opts.baseDelayMs=500] - Initial backoff delay
 * @param {number} [opts.maxDelayMs=5000] - Cap on backoff delay
 * @param {number} [opts.timeoutMs=15000] - Per-attempt timeout
 * @param {Function} [opts.retryOn] - (err) => boolean; defaults to isRetryableHttpError
 * @param {Function} [opts.onRetry] - (err, attempt, nextDelayMs) => void; logging hook
 * @returns {Promise<*>} The result of fn
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 2,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    timeoutMs = 15000,
    retryOn = isRetryableHttpError,
    onRetry = null,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !retryOn(err)) {
        throw err;
      }

      // Exponential backoff with jitter: delay = min(maxDelay, base * 2^attempt) * (0.5 + random*0.5)
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jitter = 0.5 + Math.random() * 0.5;
      const delayMs = Math.round(expDelay * jitter);

      if (onRetry) {
        onRetry(err, attempt + 1, delayMs);
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

module.exports = { sleep, withRetry, withTimeout, isRetryableHttpError };
