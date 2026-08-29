'use strict';

const TTSPort = require('../../../core/ports/tts');
const { wavToRawPcm } = require('../../../utils/audio');
const logger = require('../../../utils/logger');
const { withRetry } = require('../../../utils/retry');

/**
 * Sarvam TTS Streaming Adapter (WebSocket)
 *
 * Uses Sarvam's WebSocket TTS API for real-time streaming audio generation.
 * Maintains a persistent WebSocket connection — send config once, then stream
 * text in and receive base64 audio chunks back.
 *
 * Protocol:
 *   1. Connect to wss://api.sarvam.ai/text-to-speech/ws
 *   2. Send config message (speaker, language, codec, pace)
 *   3. Send text messages (≤2500 chars each, <500 recommended)
 *   4. Receive audio chunks as { type: "audio", data: "<base64>" }
 *   5. Send flush to force processing of buffered text
 *   6. Send ping periodically to keep connection alive (auto-close after 1 min idle)
 *
 * Barge-in: No server-side cancel. Close the socket to stop generation.
 *
 * Also retains the blocking synthesize() method for backward compatibility
 * (used by the telephony/Vapi path).
 */
class SarvamTTSAdapter extends TTSPort {
  constructor() {
    super();
    this._ws = null;
    this._wsConfig = null;
    this._disposed = false;
    this._pingInterval = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Blocking REST API (backward-compatible, used by telephony path)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Synthesize text to raw PCM audio via Sarvam's REST TTS API (blocking).
   * @param {Object} request - { text, sampleRate, ... }
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @returns {Buffer} Raw PCM audio buffer
   */
  async synthesize(request, config, env) {
    const apiKey = env[config.api_key_env];
    if (!apiKey) {
      throw new Error(`Missing env var: ${config.api_key_env}`);
    }

    const requestBody = {
      inputs: request.text,
      target_language_code: config.target_language_code,
      speaker: config.speaker,
      model: config.model,
      speech_sample_rate: request.sampleRate || config.speech_sample_rate,
      output_audio_codec: config.output_audio_codec || 'mulaw',
      pace: config.pace || 0.9,
    };

    const data = await withRetry(
      async (signal) => {
        const response = await fetch('https://api.sarvam.ai/text-to-speech', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'API-Subscription-Key': apiKey,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`Sarvam TTS error (${response.status}): ${errorText}`);
          err.status = response.status;
          logger.error('tts_sarvam_error', err, { status: response.status });
          throw err;
        }

        return await response.json();
      },
      {
        maxRetries: 2,
        timeoutMs: 10000,
        onRetry: (err, attempt, delayMs) => {
          logger.log('tts_sarvam_retry', { attempt, delayMs, error: err.message });
        },
      }
    );

    const audioBuffer = Buffer.from(data.audios[0], 'base64');
    return wavToRawPcm(audioBuffer);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Streaming WebSocket API (used by playground voice agent)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Connect to the Sarvam TTS WebSocket and send the config message.
   *
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   * @param {Object} [overrides] - Optional overrides (language, sampleRate, codec)
   * @returns {Promise<void>}
   */
  async connectStream(config, env, overrides = {}) {
    if (this._ws) {
      await this.disconnectStream();
    }

    this._disposed = false;
    const apiKey = env[config.api_key_env];
    if (!apiKey) {
      throw new Error(`Missing env var: ${config.api_key_env}`);
    }

    const WebSocket = require('ws');
    const url = 'wss://api.sarvam.ai/text-to-speech/ws';
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'API-Subscription-Key': apiKey,
    };

    this._ws = new WebSocket(url, { headers });
    this._wsConfig = { config, overrides };

    await new Promise((resolve, reject) => {
      this._ws.once('open', resolve);
      this._ws.once('error', reject);
    });

    // Send config message
    const configMessage = {
      type: 'config',
      data: {
        speaker: config.speaker,
        language_code: overrides.target_language_code || config.target_language_code,
        pace: config.pace || 0.9,
        max_chunk_length: 200,
        output_audio_codec: overrides.output_audio_codec || 'linear16',
        output_audio_bitrate: '128k',
      },
    };
    this._ws.send(JSON.stringify(configMessage));

    // Start keepalive ping (connection auto-closes after 1 min idle)
    this._pingInterval = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        this._ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    logger.log('tts_stream_connected', {
      speaker: configMessage.data.speaker,
      language: configMessage.data.language_code,
    });
  }

  /**
   * Send text to the TTS WebSocket and collect audio chunks via callback.
   *
   * Calls onAudioChunk(pcmBuffer) for each audio chunk received.
   * Resolves when the flush completes and all chunks for this text are delivered.
   *
   * @param {string} text - Text to synthesize (≤2500 chars, <500 recommended)
   * @param {Function} onAudioChunk - (pcmBuffer: Buffer) => void
   * @returns {Promise<void>}
   */
  async sendText(text, onAudioChunk) {
    if (!this._ws || this._ws.readyState !== 1) {
      throw new Error('TTS WebSocket not connected. Call connectStream() first.');
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        this._ws.removeListener('message', handler);
        this._ws.removeListener('error', errHandler);
        this._ws.removeListener('close', closeHandler);
      };

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'audio' && msg.data?.audio) {
            // Decode base64 audio chunk
            const audioBuffer = Buffer.from(msg.data.audio, 'base64');
            // Strip WAV header if present, otherwise pass through
            const pcm = audioBuffer.length > 44
              ? _tryStripWavHeader(audioBuffer)
              : audioBuffer;
            onAudioChunk(pcm);
          } else if (msg.type === 'final' || msg.type === 'end') {
            if (!settled) {
              settled = true;
              cleanup();
              resolve();
            }
          }
        } catch (e) {
          // Ignore parse errors on individual chunks
        }
      };

      const errHandler = (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const closeHandler = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(); // Connection closed — treat as done
        }
      };

      this._ws.on('message', handler);
      this._ws.on('error', errHandler);
      this._ws.on('close', closeHandler);

      // Send text message
      this._ws.send(JSON.stringify({
        type: 'text',
        data: { text },
      }));

      // Send flush to force processing
      this._ws.send(JSON.stringify({ type: 'flush' }));
    });
  }

  /**
   * Disconnect from the TTS WebSocket.
   * Used for barge-in (close socket to stop generation) and cleanup.
   */
  async disconnectStream() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* ignore */ }
      this._ws = null;
    }
  }

  /**
   * Check if the streaming WebSocket is connected.
   * @returns {boolean}
   */
  isStreamConnected() {
    return this._ws !== null && this._ws.readyState === 1;
  }
}

/**
 * Try to strip a WAV header from an audio buffer.
 * If the buffer doesn't look like a WAV, return it unchanged.
 * @private
 */
function _tryStripWavHeader(buffer) {
  // WAV files start with "RIFF" (0x52, 0x49, 0x46, 0x46)
  if (
    buffer.length > 44 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 &&
    buffer[2] === 0x46 && buffer[3] === 0x46
  ) {
    return wavToRawPcm(buffer);
  }
  return buffer;
}

module.exports = SarvamTTSAdapter;
