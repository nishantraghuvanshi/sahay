'use strict';

const TTSPort = require('../../../core/ports/tts');
const logger = require('../../../utils/logger');
const { withRetry } = require('../../../utils/retry');

/**
 * ElevenLabs TTS Bridge Adapter
 *
 * `tts.elevenlabs` is `integration: native` in providers.yaml — on the phone
 * path Vapi calls ElevenLabs directly and no request ever reaches this
 * server. The playground has no Vapi to run the provider for it, so it
 * always bridges regardless of that setting; this adapter is that bridge,
 * structured like sarvam.js (blocking REST call, retry, logging). Without
 * it the playground would hear a different voice than a caller does, which
 * defeats using the playground to tune the voice.
 *
 * UNVERIFIED: the request/response shape below (POST
 * /v1/text-to-speech/{voice_id}, `xi-api-key` header, `output_format` query
 * param, `pcm_<rate>` format identifiers, raw-PCM response body with no
 * header) matches ElevenLabs' published API docs but has not been
 * exercised against a live ElevenLabs account by this codebase. Flagged per
 * this project's history of assumed vendor payload shapes.
 */
class ElevenLabsTTSAdapter extends TTSPort {
  /**
   * Synthesize text to raw PCM audio via ElevenLabs' REST TTS API.
   *
   * Voice, model and voice settings all come from config/providers.yaml —
   * nothing here is hardcoded. Only the sample rate comes from the caller,
   * per TTSPort's contract.
   *
   * @param {Object} request - { text, sampleRate }
   * @param {Object} config - Provider config from providers.yaml (model, voice_id, stability, similarity_boost, api_key_env)
   * @param {Object} env - Environment variables
   * @returns {Promise<Buffer>} Raw PCM audio buffer
   */
  async synthesize(request, config, env) {
    const apiKey = env[config.api_key_env];
    if (!apiKey) {
      throw new Error(`Missing env var: ${config.api_key_env}`);
    }

    const outputFormat = _pcmFormatFor(request.sampleRate);

    const requestBody = {
      text: request.text,
      model_id: config.model,
      voice_settings: {
        stability: config.stability,
        similarity_boost: config.similarity_boost,
      },
    };

    return withRetry(
      async (signal) => {
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${config.voice_id}?output_format=${outputFormat}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': apiKey,
            },
            body: JSON.stringify(requestBody),
            signal,
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`ElevenLabs TTS error (${response.status}): ${errorText}`);
          err.status = response.status;
          logger.error('tts_elevenlabs_error', err, { status: response.status });
          throw err;
        }

        const body = Buffer.from(await response.arrayBuffer());
        _assertRawPcm(body, outputFormat);
        return body;
      },
      {
        maxRetries: 2,
        timeoutMs: 10000,
        onRetry: (err, attempt, delayMs) => {
          logger.log('tts_elevenlabs_retry', { attempt, delayMs, error: err.message });
        },
      }
    );
  }
}

/**
 * ElevenLabs `output_format` identifier for a requested sample rate.
 * ElevenLabs documents pcm_16000/22050/24000/44100 as its supported
 * raw-PCM outputs — see the UNVERIFIED note on the class above.
 *
 * Throws on any other rate rather than substituting the nearest supported
 * one: a caller asking for 8000 Hz and silently getting 16 kHz PCM back
 * would play it back at the wrong rate (chipmunked audio) with nothing
 * anywhere reporting a problem — the same silent-failure shape this
 * project keeps shipping.
 *
 * @param {number} [sampleRate=24000]
 * @returns {string} e.g. "pcm_16000"
 * @private
 */
function _pcmFormatFor(sampleRate = 24000) {
  const SUPPORTED_RATES = [16000, 22050, 24000, 44100];
  if (!SUPPORTED_RATES.includes(sampleRate)) {
    throw new Error(
      `ElevenLabs TTS: unsupported sample rate ${sampleRate} — supported rates are ${SUPPORTED_RATES.join(', ')}.`
    );
  }
  return `pcm_${sampleRate}`;
}

/**
 * Magic-byte signatures for container formats ElevenLabs could return
 * instead of raw PCM (its default MP3 body, if `output_format` names a
 * query parameter or value ElevenLabs doesn't recognize — still a 200,
 * still a body, just not the one asked for).
 * @private
 */
const CONTAINER_SIGNATURES = [
  { name: 'MP3 (ID3 tag)', bytes: [0x49, 0x44, 0x33] }, // "ID3"
  { name: 'MP3 (MPEG frame sync)', bytes: [0xff, 0xfb] },
  { name: 'WAV/RIFF', bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
];

/**
 * Reject a response body that looks like a container format rather than
 * raw PCM. A wrong or unsupported `output_format` query parameter gets a
 * 200 with ElevenLabs' default MP3 body — which the browser then plays as
 * raw PCM, i.e. static, with nothing anywhere reporting a problem. This
 * throws loudly instead, naming the likely cause.
 *
 * @param {Buffer} body
 * @param {string} outputFormat - The `output_format` value that was requested
 * @private
 */
function _assertRawPcm(body, outputFormat) {
  const match = CONTAINER_SIGNATURES.find((sig) =>
    sig.bytes.every((byte, i) => body[i] === byte)
  );
  if (match) {
    throw new Error(
      `ElevenLabs TTS returned ${match.name} data instead of raw PCM for output_format=${outputFormat} — ` +
        'the output_format query parameter is likely wrong or unsupported for this account/plan.'
    );
  }
}

module.exports = ElevenLabsTTSAdapter;
