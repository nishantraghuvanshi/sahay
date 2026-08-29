'use strict';

/**
 * TTS Port (interface)
 *
 * Synthesizes text to audio. Implementations are adapters for
 * specific providers (Sarvam, ElevenLabs, etc.).
 */
class TTSPort {
  /**
   * Synthesize text to raw PCM audio.
   * @param {Object} request - { text, sampleRate, ... }
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @returns {Buffer} Raw PCM audio buffer
   */
  async synthesize(request, config, env) {
    throw new Error('TTSPort.synthesize() not implemented');
  }
}

module.exports = TTSPort;
