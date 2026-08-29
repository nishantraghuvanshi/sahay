'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, withRetry, withTimeout, isRetryableHttpError } = require('../src/utils/retry');

describe('retry utilities', () => {
  describe('sleep', () => {
    it('resolves after the specified delay', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 40, `expected >=40ms, got ${elapsed}ms`);
    });
  });

  describe('isRetryableHttpError', () => {
    it('returns true for 5xx status', () => {
      const err = new Error('server error');
      err.status = 503;
      assert.equal(isRetryableHttpError(err), true);
    });

    it('returns true for 429 rate limit', () => {
      const err = new Error('rate limited');
      err.status = 429;
      assert.equal(isRetryableHttpError(err), true);
    });

    it('returns true for 408 timeout', () => {
      const err = new Error('timeout');
      err.status = 408;
      assert.equal(isRetryableHttpError(err), true);
    });

    it('returns false for 4xx client errors', () => {
      const err = new Error('bad request');
      err.status = 400;
      assert.equal(isRetryableHttpError(err), false);
    });

    it('returns false for 401 auth errors', () => {
      const err = new Error('unauthorized');
      err.status = 401;
      assert.equal(isRetryableHttpError(err), false);
    });

    it('returns true for TypeError (network failure)', () => {
      const err = new TypeError('fetch failed');
      assert.equal(isRetryableHttpError(err), true);
    });

    it('returns true for AbortError (timeout)', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      assert.equal(isRetryableHttpError(err), true);
    });

    it('extracts status from message pattern', () => {
      const err = new Error('Sarvam LLM error (503): service unavailable');
      assert.equal(isRetryableHttpError(err), true);
    });

    it('returns false for unknown errors', () => {
      const err = new Error('something weird');
      assert.equal(isRetryableHttpError(err), false);
    });
  });

  describe('withTimeout', () => {
    it('returns the result when fn completes in time', async () => {
      const result = await withTimeout(async (signal) => {
        return 'ok';
      }, 1000);
      assert.equal(result, 'ok');
    });

    it('throws AbortError when fn exceeds timeout', async () => {
      await assert.rejects(
        withTimeout(async (signal) => {
          await sleep(200);
          return 'late';
        }, 50),
        (err) => err.name === 'AbortError'
      );
    });
  });

  describe('withRetry', () => {
    it('returns the result on first try', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        return 'success';
      }, { maxRetries: 2, baseDelayMs: 1 });
      assert.equal(result, 'success');
      assert.equal(calls, 1);
    });

    it('retries on retryable errors and succeeds', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        if (calls < 2) {
          const err = new Error('server error');
          err.status = 503;
          throw err;
        }
        return 'recovered';
      }, { maxRetries: 2, baseDelayMs: 1 });
      assert.equal(result, 'recovered');
      assert.equal(calls, 2);
    });

    it('does not retry on non-retryable errors', async () => {
      let calls = 0;
      await assert.rejects(
        withRetry(async () => {
          calls++;
          const err = new Error('bad request');
          err.status = 400;
          throw err;
        }, { maxRetries: 2, baseDelayMs: 1 }),
        /bad request/
      );
      assert.equal(calls, 1);
    });

    it('throws after exhausting retries', async () => {
      let calls = 0;
      await assert.rejects(
        withRetry(async () => {
          calls++;
          const err = new Error('server error');
          err.status = 503;
          throw err;
        }, { maxRetries: 2, baseDelayMs: 1 }),
        /server error/
      );
      assert.equal(calls, 3); // initial + 2 retries
    });

    it('calls onRetry hook before each retry', async () => {
      const retries = [];
      let calls = 0;
      await withRetry(async () => {
        calls++;
        if (calls < 3) {
          const err = new Error('server error');
          err.status = 503;
          throw err;
        }
        return 'ok';
      }, {
        maxRetries: 3,
        baseDelayMs: 1,
        onRetry: (err, attempt, delayMs) => {
          retries.push({ attempt, error: err.message });
        },
      });
      assert.equal(retries.length, 2);
      assert.equal(retries[0].attempt, 1);
      assert.equal(retries[1].attempt, 2);
    });

    it('respects timeoutMs per attempt', async () => {
      await assert.rejects(
        withRetry(async (signal) => {
          await sleep(300);
          return 'late';
        }, { maxRetries: 1, timeoutMs: 50, baseDelayMs: 1 }),
        (err) => err.name === 'AbortError'
      );
    });
  });
});
