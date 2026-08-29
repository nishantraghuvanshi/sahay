'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSSEStream } = require('../src/utils/sse');

/**
 * Create a mock Response with a streaming body for SSE testing.
 * @param {string[]} chunks - Array of SSE data strings to emit
 * @returns {Response}
 */
function mockSSEResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('parseSSEStream', () => {
  it('parses content deltas from SSE stream', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const deltas = [];
    await parseSSEStream(mockSSEResponse(chunks), (delta) => deltas.push(delta));

    assert.equal(deltas.length, 3);
    assert.equal(deltas[0].content, 'Hello');
    assert.equal(deltas[1].content, ' world');
    assert.equal(deltas[2].content, '!');
  });

  it('handles tool call deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"report_outcome","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"outcome\\":\\"CONFIRMED\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const deltas = [];
    await parseSSEStream(mockSSEResponse(chunks), (delta) => deltas.push(delta));

    assert.equal(deltas.length, 2);
    assert.ok(deltas[0].tool_calls);
    assert.ok(deltas[1].tool_calls);
  });

  it('stops at [DONE]', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    ];

    const deltas = [];
    await parseSSEStream(mockSSEResponse(chunks), (delta) => deltas.push(delta));

    // [DONE] returns null, so only "A" is emitted
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].content, 'A');
  });

  it('handles multiple events in one chunk', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    ];

    const deltas = [];
    await parseSSEStream(mockSSEResponse(chunks), (delta) => deltas.push(delta));

    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].content, 'Hi');
    assert.equal(deltas[1].content, ' there');
  });

  it('ignores malformed JSON lines', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      'data: not json\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    ];

    const deltas = [];
    await parseSSEStream(mockSSEResponse(chunks), (delta) => deltas.push(delta));

    assert.equal(deltas.length, 2);
  });

  it('handles empty stream', async () => {
    const deltas = [];
    await parseSSEStream(mockSSEResponse([]), (delta) => deltas.push(delta));
    assert.equal(deltas.length, 0);
  });

  it('handles partial data across chunk boundaries', async () => {
    // Split a single SSE event across two chunks
    const chunks = [
      'data: {"choices":[{"delta":{"content":"He',
      'llo"}}]}\n\n',
    ];

    const deltas = [];
    await parseSSEStream(mockSSEResponse(chunks), (delta) => deltas.push(delta));

    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].content, 'Hello');
  });
});
