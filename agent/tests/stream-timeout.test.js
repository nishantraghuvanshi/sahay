'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithStreamTimeout } = require('../src/utils/stream-timeout');

/**
 * Build a fake streaming Response whose body drip-feeds chunks according to
 * a script, so tests can simulate a provider that never responds, stalls
 * mid-stream, or streams steadily for longer than the idle timeout.
 *
 * @param {Array<{delayMs: number, text?: string}>} script - each entry waits
 *   delayMs then, if `text` is given, enqueues it; the last entry with no
 *   `text` closes the stream. An empty script never enqueues or closes.
 * @param {{signal?: AbortSignal}} [trackAbort] - if given, .aborted is set
 *   true when the fetch's AbortSignal fires.
 */
function fakeStreamingFetch(script) {
  let aborted = false;
  const encoder = new TextEncoder();

  const fetchFn = async (url, options) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
    });

    const stream = new ReadableStream({
      async start(controller) {
        for (const step of script) {
          // Abortable delay: a real upstream connection dies immediately on
          // abort, and this must too, or a dangling setTimeout keeps the
          // event loop (and the test run) alive long after the test itself
          // has finished asserting.
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, step.delayMs);
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          });
          if (options.signal.aborted) return; // upstream would stop pushing once aborted
          if (step.text !== undefined) {
            controller.enqueue(encoder.encode(step.text));
          } else {
            controller.close();
            return;
          }
        }
      },
    });

    return { ok: true, status: 200, body: stream };
  };

  return { fetchFn, isAborted: () => aborted };
}

async function drain(response) {
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks.join('');
}

describe('fetchWithStreamTimeout', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('aborts and throws a distinguishable error when no first chunk ever arrives', async () => {
    // Script never enqueues or closes — simulates a provider that connects
    // (fetch() itself resolves) and then never sends a byte. The timeout
    // only surfaces once something reads the body, exactly like a real
    // caller (parseSSEStream) would — so this drains the response rather
    // than expecting fetchWithStreamTimeout() itself to reject.
    const { fetchFn, isAborted } = fakeStreamingFetch([{ delayMs: 10_000 }]);
    global.fetch = fetchFn;

    const response = await fetchWithStreamTimeout(
      'https://example.test/stream',
      {},
      { provider: 'testprovider', firstChunkTimeoutMs: 30, idleTimeoutMs: 1000 }
    );

    await assert.rejects(drain(response), (err) => {
      assert.match(err.message, /testprovider/);
      assert.match(err.message, /first chunk/);
      assert.equal(err.name, 'StreamTimeoutError');
      assert.equal(err.stage, 'first-chunk');
      return true;
    });

    assert.equal(isAborted(), true, 'fetch should have been aborted on timeout');
  });

  it('aborts and throws when fetch() itself never resolves (no connection at all)', async () => {
    let signalSeen;
    global.fetch = (url, options) => {
      signalSeen = options.signal;
      return new Promise(() => {}); // never resolves
    };

    await assert.rejects(
      fetchWithStreamTimeout(
        'https://example.test/stream',
        {},
        { provider: 'testprovider', firstChunkTimeoutMs: 30, idleTimeoutMs: 1000 }
      ),
      (err) => {
        assert.match(err.message, /testprovider/);
        assert.equal(err.name, 'StreamTimeoutError');
        assert.equal(err.stage, 'first-chunk');
        return true;
      }
    );

    assert.equal(signalSeen.aborted, true, 'fetch should have been aborted on connect timeout');
  });

  it('aborts and throws when chunks arrive then the stream goes quiet', async () => {
    const { fetchFn, isAborted } = fakeStreamingFetch([
      { delayMs: 5, text: 'hello' },
      { delayMs: 10_000, text: 'never arrives' },
    ]);
    global.fetch = fetchFn;

    const response = await fetchWithStreamTimeout(
      'https://example.test/stream',
      {},
      { provider: 'testprovider', firstChunkTimeoutMs: 1000, idleTimeoutMs: 30 }
    );

    await assert.rejects(drain(response), (err) => {
      assert.match(err.message, /testprovider/);
      assert.equal(err.name, 'StreamTimeoutError');
      assert.equal(err.stage, 'idle');
      return true;
    });

    assert.equal(isAborted(), true, 'fetch should have been aborted on idle timeout');
  });

  it('does not abort a stream that keeps sending chunks steadily past the idle timeout', async () => {
    // Each gap (15ms) is well under the 30ms idle timeout, but the total
    // stream duration (60ms) comfortably exceeds it — proving the timeout
    // resets per chunk instead of bounding the whole stream.
    const { fetchFn, isAborted } = fakeStreamingFetch([
      { delayMs: 15, text: 'a' },
      { delayMs: 15, text: 'b' },
      { delayMs: 15, text: 'c' },
      { delayMs: 15, text: 'd' },
      { delayMs: 15 },
    ]);
    global.fetch = fetchFn;

    const response = await fetchWithStreamTimeout(
      'https://example.test/stream',
      {},
      { provider: 'testprovider', firstChunkTimeoutMs: 1000, idleTimeoutMs: 30 }
    );

    const text = await drain(response);
    assert.equal(text, 'abcd');
    assert.equal(isAborted(), false, 'a steadily-streaming response must not be aborted');
  });

  it('leaves a normal completed stream unaffected', async () => {
    const { fetchFn, isAborted } = fakeStreamingFetch([
      { delayMs: 1, text: 'one ' },
      { delayMs: 1, text: 'two ' },
      { delayMs: 1, text: 'three' },
      { delayMs: 1 },
    ]);
    global.fetch = fetchFn;

    const response = await fetchWithStreamTimeout(
      'https://example.test/stream',
      {},
      { provider: 'testprovider', firstChunkTimeoutMs: 1000, idleTimeoutMs: 1000 }
    );

    assert.equal(response.ok, true);
    const text = await drain(response);
    assert.equal(text, 'one two three');
    assert.equal(isAborted(), false);
  });

  it('passes through a non-ok response without wrapping', async () => {
    global.fetch = async () => ({ ok: false, status: 500, body: null });

    const response = await fetchWithStreamTimeout(
      'https://example.test/stream',
      {},
      { provider: 'testprovider', firstChunkTimeoutMs: 1000, idleTimeoutMs: 1000 }
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, 500);
  });
});
