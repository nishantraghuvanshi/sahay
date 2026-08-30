'use strict';

const STTPort = require('../../../core/ports/stt');
const { extractChannel, pcmToWav } = require('../../../utils/audio');
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
    this.sampleRate = 16000; // fallback used only when nothing is announced per-call

    // Reconnection state
    this._disposed = false;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 3;
    this._reconnectBaseDelayMs = 500;
    this._reconnectTimer = null;
    this._connectPromise = null;

    // The sample rate the currently open/connecting socket was opened with.
    // Per-call, not per-init — the caller (transcribe) decides this every
    // time, the same way streamChannels is decided per-call in vapi.js, so
    // two concurrent calls on two instances never share a rate.
    this._activeSampleRate = null;
    this._switchingRate = false;
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
   * @param {number} sampleRate - the rate to connect at; caller resolves
   *   this per-stream (announced rate, or the configured fallback).
   * @private
   */
  _connectSarvam(sampleRate) {
    const WebSocket = require('ws');
    this._activeSampleRate = sampleRate;

    // Endpoint and auth verified against docs.sarvam.ai (api-reference/legacy/
    // speech-to-text/transcribe/ws). The previous URL was
    // '/speech-to-text/streaming', which does not exist — every connection was
    // rejected with a 403 that looked like an invalid key. The key was fine.
    // Auth is the api-subscription-key header; Bearer is not accepted here.
    const params = new URLSearchParams({
      model: this.config.model,
      language_code: this.config.language,
      mode: this.config.mode,
      sample_rate: String(sampleRate),
      high_vad_sensitivity: String(!!this.config.high_vad_sensitivity),
    });
    const url = `wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`;
    const headers = {
      'api-subscription-key': this.apiKey,
    };

    // Bind every handler to THIS socket, not to this.ws. A reconnect
    // reassigns this.ws, so an older socket's 'open' would otherwise fire and
    // send on the newer, still-CONNECTING socket — which throws
    // "WebSocket is not open: readyState 0" out of an event handler and, being
    // uncaught, takes the whole server process down with it.
    const ws = new WebSocket(url, { headers });
    this.ws = ws;

    ws.on('open', () => {
      // Deliberately sends NOTHING. This endpoint has no config handshake —
      // every setting travels in the URL query string, and every frame it
      // receives is expected to be audio. Sending a config object here made
      // Sarvam answer
      //   {"type":"error","data":{"message":"Invalid request: 'audio' must not be..."}}
      // and hang up, which presented as an endless connect/close reconnect loop.
      logger.log('stt_sarvam_connected', {
        model: this.config.model,
        language: this.config.language,
      });
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'error') {
          logger.error(
            'stt_sarvam_remote_error',
            new Error(message.data?.message || JSON.stringify(message))
          );
          return;
        }

        // Transcripts arrive either flat or wrapped in a {type, data} envelope
        // depending on the endpoint generation — accept both.
        const payload = message.data || message;
        if (payload.transcript && this.transcriptCallback) {
          // This endpoint emits NO partial results: there is no is_final field,
          // and every transcript message is already the final text for that
          // speech segment. Forwarding payload.is_final passed `undefined`,
          // which every downstream caller read as "partial" — so a completed
          // utterance was re-entered as an interim result on every message and
          // a turn could only ever be closed by the silence timeout.
          this.transcriptCallback(payload.transcript, true, 'customer');
        }
      } catch (e) {
        logger.error('stt_sarvam_message_parse_error', e);
      }
    });

    ws.on('error', (err) => {
      logger.error('stt_sarvam_ws_error', err);
    });

    ws.on('close', () => {
      logger.log('stt_sarvam_ws_closed', {});
      // Auto-reconnect if not intentionally disposed and we have a callback.
      // Skipped mid rate-switch — _reconnectAtRate is already opening the
      // replacement socket; this handler firing for the old socket's close
      // would otherwise race it with a second, stale-rate reconnect.
      if (!this._disposed && !this._switchingRate && this.transcriptCallback) {
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
        this._connectSarvam(this._activeSampleRate ?? this.sampleRate);
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

  /**
   * Open the socket at most once, however many chunks arrive while it is
   * opening.
   *
   * The previous guard tested `readyState !== 1`, which is true throughout
   * CONNECTING as well as when closed. Audio arrives every ~100ms and the
   * handshake takes ~600ms, so every chunk in that window opened ANOTHER
   * socket: 22 of them in 1.5 seconds in one observed session, each
   * reassigning this.ws, each independently transcribing, and each a candidate
   * to emit its own transcript for the same speech.
   *
   * Callers await the one in-flight connect instead.
   *
   * @param {number} sampleRate - rate to connect at if a new socket is opened
   * @private
   */
  _ensureConnected(sampleRate) {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;

    this._connectSarvam(sampleRate);
    const ws = this.ws;

    this._connectPromise = new Promise((resolve, reject) => {
      const settle = () => {
        this._connectPromise = null;
      };
      ws.once('open', () => {
        settle();
        resolve();
      });
      ws.once('error', (err) => {
        settle();
        reject(err);
      });
      // A socket closed before it ever opened must reject, or every caller
      // awaiting this promise hangs forever holding a dead connection.
      ws.once('close', () => {
        settle();
        reject(new Error('Sarvam socket closed before opening'));
      });
    });

    return this._connectPromise;
  }

  /**
   * Swap the live socket for one opened at the correct sample rate.
   *
   * Only needed if audio starts arriving — and a socket gets opened — before
   * Vapi's 'start' message is read, or a stream somehow re-announces a
   * different rate mid-call. In the common case transcribe() resolves the
   * rate before ever connecting, so this path doesn't run.
   *
   * @private
   */
  async _reconnectAtRate(sampleRate) {
    logger.log('stt_sample_rate_corrected', {
      from: this._activeSampleRate,
      to: sampleRate,
    });

    this._switchingRate = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;

    const staleWs = this.ws;
    this.ws = null;
    if (staleWs) staleWs.close();

    try {
      await this._ensureConnected(sampleRate);
    } finally {
      this._switchingRate = false;
    }
  }

  async transcribe(audioChunk, onTranscript, opts = {}) {
    this.transcriptCallback = onTranscript;

    // Channel count is a property of the CALLER, not of Sarvam: Vapi streams
    // 2-channel PCM, the playground streams mono. Defaulting to mono means a
    // caller that forgets to say is merely un-de-interleaved, not decimated to
    // every other sample — which is what happened to playground audio while
    // this was hardcoded to 2.
    const channels = opts.channels || 1;

    // Sample rate is likewise per-stream, not per-instance: Vapi announces
    // the real rate in its 'start' message (see vapi.js), which arrives as
    // opts.sampleRate here. this.sampleRate (from providers.yaml) is only a
    // fallback for when nothing was announced. Resolving this from opts each
    // call — not caching it on the adapter at init() — is what makes it safe
    // for one adapter instance to ever be reused across streams.
    const sampleRate = opts.sampleRate || this.sampleRate;

    try {
      if (this.ws && this.ws.readyState === 1 && this._activeSampleRate !== sampleRate) {
        await this._reconnectAtRate(sampleRate);
      } else {
        await this._ensureConnected(sampleRate);
      }
    } catch (err) {
      // Dropping one audio chunk is survivable; throwing out of here is not —
      // this runs per chunk, several times a second, mid-call.
      logger.error('stt_sarvam_connect_failed', err);
      return;
    }

    const callerAudio =
      channels > 1 ? extractChannel(audioChunk, 0, channels) : audioChunk;

    if (this.ws.readyState === 1 /* OPEN */) {
      // Sarvam's streaming endpoint takes base64 inside a JSON envelope, not
      // raw binary frames:
      //   {"audio": {"data": "<base64>", "sample_rate": N, "encoding": "linear16"}}
      this.ws.send(
        JSON.stringify({
          audio: {
            data: pcmToWav(Buffer.from(callerAudio), sampleRate).toString(
              'base64'
            ),
            sample_rate: sampleRate,
            encoding: 'audio/wav',
          },
        })
      );
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
