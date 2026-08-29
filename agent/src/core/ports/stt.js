'use strict';

/**
 * STT Port (interface)
 *
 * Transcribes audio to text. Implementations are adapters for specific
 * providers (Sarvam, Deepgram, etc.).
 */
class STTPort {
  /**
   * Called when a conversation starts and audio streaming begins.
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   */
  async init(config, env) {
    throw new Error('STTPort.init() not implemented');
  }

  /**
   * Process a chunk of audio and return transcripts via callback.
   * @param {Buffer} audioChunk - Raw PCM audio
   * @param {Function} onTranscript - (transcript, isFinal, channel) => void
   */
  async transcribe(audioChunk, onTranscript) {
    throw new Error('STTPort.transcribe() not implemented');
  }

  /** Clean up resources when conversation ends. */
  async dispose() {
    throw new Error('STTPort.dispose() not implemented');
  }
}

module.exports = STTPort;
