'use strict';

/**
 * Sentence Buffer
 *
 * Accumulates LLM token deltas and emits complete sentences for TTS.
 *
 * A "sentence" is text up to a sentence-ending punctuation mark (. ! ? । ?)
 * followed by whitespace, or a flush() call. This lets us send text to the
 * TTS WebSocket as soon as a sentence is complete — before the LLM finishes
 * generating the full response.
 *
 * Hindi sentence terminators include the Devanagari danda (।).
 */

// Sentence-ending punctuation (Latin + Devanagari danda)
const SENTENCE_ENDERS = /([.!?।]\s)/;

class SentenceBuffer {
  constructor() {
    this._buffer = '';
    this._onSentence = null;
  }

  /**
   * Set the callback for complete sentences.
   * @param {Function} cb - (sentence: string) => void
   */
  onSentence(cb) {
    this._onSentence = cb;
  }

  /**
   * Push a token delta into the buffer.
   * Calls onSentence for each complete sentence found.
   *
   * @param {string} token - LLM token delta
   */
  push(token) {
    this._buffer += token;

    // Split on sentence boundaries
    let match;
    while ((match = SENTENCE_ENDERS.exec(this._buffer))) {
      const endIdx = match.index + match[0].length;
      const sentence = this._buffer.slice(0, endIdx).trim();
      this._buffer = this._buffer.slice(endIdx);

      if (sentence && this._onSentence) {
        this._onSentence(sentence);
      }
    }
  }

  /**
   * Flush remaining buffer as a final sentence.
   */
  flush() {
    const remaining = this._buffer.trim();
    this._buffer = '';
    if (remaining && this._onSentence) {
      this._onSentence(remaining);
    }
  }

  /**
   * Reset the buffer (e.g., on barge-in).
   */
  reset() {
    this._buffer = '';
  }

  /**
   * Get the current buffered text (for debugging).
   * @returns {string}
   */
  getPending() {
    return this._buffer;
  }
}

module.exports = { SentenceBuffer };
