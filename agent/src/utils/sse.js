'use strict';

/**
 * SSE (Server-Sent Events) Stream Parser
 *
 * Parses a ReadableStream of SSE data from OpenAI-compatible APIs.
 * Extracts content deltas and tool call deltas from each chunk.
 *
 * SSE format:
 *   data: {"choices":[{"delta":{"content":"Hello"}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[...]}}]}
 *   data: [DONE]
 */

/**
 * Parse an SSE stream from a fetch Response, calling onDelta for each chunk.
 *
 * @param {Response} response - fetch Response with a streaming body
 * @param {Function} onDelta - (delta) => void, called for each parsed delta object
 * @returns {Promise<void>}
 */
async function parseSSEStream(response, onDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  try {
    while (!done) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      let newlineIndex;
      while (!done && (newlineIndex = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 2);

        const result = _parseSSEBlock(eventBlock);
        if (result === 'DONE') {
          done = true;
          break;
        }
        if (result) onDelta(result);
      }
    }

    // Flush any remaining data in the buffer (unless we hit [DONE])
    if (!done && buffer.trim()) {
      const result = _parseSSEBlock(buffer);
      if (result && result !== 'DONE') onDelta(result);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a single SSE event block into a delta object.
 * @private
 */
function _parseSSEBlock(block) {
  const lines = block.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return 'DONE';

    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (delta) return delta;
    } catch {
      // Ignore malformed JSON — some providers send comments or keepalives
    }
  }

  return null;
}

module.exports = { parseSSEStream };
