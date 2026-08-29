'use strict';

/**
 * Audio Utilities
 *
 * Helpers for processing PCM audio data:
 * - Channel extraction from interleaved multi-channel PCM
 * - WAV header parsing and raw PCM extraction
 */

/**
 * Extract a single channel from interleaved multi-channel 16-bit PCM.
 *
 * Vapi sends 2-channel interleaved PCM (caller + assistant) over WebSocket.
 * Channel 0 = caller, Channel 1 = assistant.
 * Extract channel 0 (caller) for STT.
 *
 * @param {Buffer} audioBuffer - Interleaved 16-bit PCM audio
 * @param {number} channelIndex - Which channel to extract (0-based)
 * @param {number} channelCount - Total number of channels
 * @returns {Buffer} Single-channel 16-bit PCM
 */
function extractChannel(audioBuffer, channelIndex, channelCount) {
  const bytesPerSample = 2; // 16-bit = 2 bytes per sample
  const frameSize = bytesPerSample * channelCount; // bytes per sample frame
  const frameCount = Math.floor(audioBuffer.length / frameSize);
  const output = Buffer.alloc(frameCount * bytesPerSample);

  for (let i = 0; i < frameCount; i++) {
    const srcOffset = i * frameSize + channelIndex * bytesPerSample;
    const dstOffset = i * bytesPerSample;
    output.writeInt16LE(audioBuffer.readInt16LE(srcOffset), dstOffset);
  }

  return output;
}

/**
 * Find the offset of audio data in a WAV buffer by searching for "data" chunk marker.
 *
 * WAV files have a header with chunks. The audio data follows the "data" chunk
 * marker (4 bytes) and chunk size (4 bytes). This function searches for the
 * "data" marker and returns the offset where raw PCM begins.
 *
 * @param {Buffer} buffer - WAV file buffer
 * @returns {number} Byte offset where raw PCM audio data begins
 */
function findDataChunk(buffer) {
  // Search for "data" marker (ASCII: d=0x64, a=0x61, t=0x74, a=0x61)
  for (let i = 0; i < buffer.length - 4; i++) {
    if (
      buffer[i] === 0x64 &&
      buffer[i + 1] === 0x61 &&
      buffer[i + 2] === 0x74 &&
      buffer[i + 3] === 0x61
    ) {
      // Skip "data" marker (4 bytes) + chunk size (4 bytes) = 8 bytes
      return i + 8;
    }
  }
  // Fallback: assume standard 44-byte WAV header
  return 44;
}

/**
 * Strip WAV header to get raw PCM audio.
 *
 * Vapi expects raw PCM, not WAV. This finds the "data" chunk and returns
 * everything after it.
 *
 * @param {Buffer} wavBuffer - WAV file buffer
 * @returns {Buffer} Raw PCM audio data
 */
function wavToRawPcm(wavBuffer) {
  const dataOffset = findDataChunk(wavBuffer);
  return wavBuffer.subarray(dataOffset);
}

module.exports = { extractChannel, wavToRawPcm, findDataChunk };
