'use strict';

const STTPort = require('../../../core/ports/stt');
const { extractChannel } = require('../../../utils/audio');
const logger = require('../../../utils/logger');

/**
 * Sarvam STT Adapter
 *
 * Connects to the Sarvam Saaras v3 streaming WebSocket API.
 * Vapi sends 2-channel interleaved PCM (caller + assistant) — this adapter
 * extracts the caller channel (channel 0) and streams it to Sarvam for
 * transcription, forwarding transcripts back via callback.
 */
class SarvamSTTAdapter extends STTPort {
  constructor() {
    super();
    this.config = null;
    this.env = null;
    this.apiKey = null;
    this.ws = null;
    this.transcriptCallback = null;
    this.sampleRate = 16000;

    // Reconnection state
    this._disposed = false;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 3;
    this._reconnectBaseDelayMs = 500;
    this._reconnectTimer = null;
    this._connecting = false;
  }

  /**
   * Initialize the STT adapter with provider config.
   * @param {Object} config - Provider config from providers.yaml
   * @param {Object} env - Environment variables
   */
  async init(config, env) {
    this.config = config;
    this.env = env;
    this.apiKey = env[config.api_key_env];

    if (!this.apiKey) {
      throw new Error(`Missing env var: ${config.api_key_env}`);
    }

    this.sampleRate = config.sample_rate || 16000;
  }

  /**
   * Connect to the Sarvam Saaras v3 streaming WebSocket.
   * Sends initial config on connect and sets up transcript listener.
   * @private
   */
  _connectSarvam() {
    const WebSocket = require('ws');

    const url = 'wss://api.sarvam.ai/speech-to-text/streaming';
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'API-Subscription-Key': this.apiKey,
    };

    this.ws = new WebSocket(url, { headers });

    this.ws.on('open', () => {
      // Send config message on connect
      const configMessage = {
        model: this.config.model,
        language: this.config.language,
        mode: this.config.mode,
        sample_rate: this.sampleRate,
        input_audio_codec: 'pcm_s16le',
        high_vad_sensitivity: this.config.high_vad_sensitivity
          ? 'true'
          : 'false',
      };
      this.ws.send(JSON.stringify(configMessage));
      logger.log('stt_sarvam_connected', {
        model: this.config.model,
        language: this.config.language,
      });
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.transcript && this.transcriptCallback) {
          this.transcriptCallback(
            message.transcript,
            message.is_final,
            'customer'
          );
        }
      } catch (e) {
        logger.error('stt_sarvam_message_parse_error', e);
      }
    });

    this.ws.on('error', (err) => {
      logger.error('stt_sarvam_ws_error', err);
    });

    this.ws.on('close', () => {
      logger.log('stt_sarvam_ws_closed', {});
      // Auto-reconnect if not intentionally disposed and we have a callback
      if (!this._disposed && this.transcriptCallback) {
        this._scheduleReconnect();
      }
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    if (this._reconnectTimer || this._disposed) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      logger.error('stt_sarvam_reconnect_exhausted', new Error(
        `Failed to reconnect after ${this._maxReconnectAttempts} attempts`
      ));
      return;
    }

    const delay = Math.min(
      this._reconnectBaseDelayMs * Math.pow(2, this._reconnectAttempts),
      5000
    );
    this._reconnectAttempts++;

    logger.log('stt_sarvam_reconnect_scheduled', {
      attempt: this._reconnectAttempts,
      delayMs: delay,
    });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._disposed) return;

      try {
        this._connectSarvam();
        await new Promise((resolve, reject) => {
          if (this.ws.readyState === 1) {
            resolve();
          } else {
            this.ws.once('open', resolve);
            this.ws.once('error', reject);
          }
        });
        this._reconnectAttempts = 0;
        logger.log('stt_sarvam_reconnected', {});
      } catch (err) {
        logger.error('stt_sarvam_reconnect_failed', err);
        // Try again if we haven't exhausted attempts
        this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Process a chunk of audio and forward transcripts via callback.
   *
   * Vapi sends 2-channel interleaved 16-bit PCM (caller + assistant).
   * We extract channel 0 (caller) and send it to Sarvam.
   *
   * @param {Buffer} audioChunk - Raw 2-channel PCM audio from Vapi
   * @param {Function} onTranscript - (transcript, isFinal, channel) => void
   */
  async transcribe(audioChunk, onTranscript) {
    this.transcriptCallback = onTranscript;

    // Connect to Sarvam if not yet connected
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      this._connectSarvam();
      // Wait for connection to open before sending audio
      await new Promise((resolve, reject) => {
        if (this.ws.readyState === 1) {
          resolve();
        } else {
          this.ws.once('open', resolve);
          this.ws.once('error', reject);
        }
      });
    }

    // Extract caller channel (channel 0 from 2-channel PCM)
    const callerAudio = extractChannel(audioChunk, 0, 2);

    if (this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(callerAudio);
    }
  }

  /**
   * Close the Sarvam WebSocket connection.
   */
  async dispose() {
    this._disposed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.transcriptCallback = null;
  }
}

module.exports = SarvamSTTAdapter;
