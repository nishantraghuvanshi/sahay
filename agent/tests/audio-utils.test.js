'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { extractChannel, findDataChunk, wavToRawPcm } = require('../src/utils/audio');

describe('extractChannel', () => {
  test('extracts channel 0 from 2-channel interleaved PCM', () => {
    // 4 frames, 2 channels, 16-bit LE
    // Channel 0: 100, 200, 300, 400
    // Channel 1: 500, 600, 700, 800
    const input = Buffer.alloc(16); // 4 frames * 2 channels * 2 bytes
    for (let i = 0; i < 4; i++) {
      input.writeInt16LE(100 + i * 100, i * 4);      // channel 0
      input.writeInt16LE(500 + i * 100, i * 4 + 2);  // channel 1
    }
    const result = extractChannel(input, 0, 2);
    assert.strictEqual(result.length, 8); // 4 frames * 2 bytes
    assert.strictEqual(result.readInt16LE(0), 100);
    assert.strictEqual(result.readInt16LE(2), 200);
    assert.strictEqual(result.readInt16LE(4), 300);
    assert.strictEqual(result.readInt16LE(6), 400);
  });

  test('extracts channel 1 from 2-channel interleaved PCM', () => {
    const input = Buffer.alloc(16);
    for (let i = 0; i < 4; i++) {
      input.writeInt16LE(100 + i * 100, i * 4);
      input.writeInt16LE(500 + i * 100, i * 4 + 2);
    }
    const result = extractChannel(input, 1, 2);
    assert.strictEqual(result.readInt16LE(0), 500);
    assert.strictEqual(result.readInt16LE(2), 600);
    assert.strictEqual(result.readInt16LE(4), 700);
    assert.strictEqual(result.readInt16LE(6), 800);
  });

  test('handles single-channel audio (passthrough)', () => {
    const input = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) {
      input.writeInt16LE(100 + i, i * 2);
    }
    const result = extractChannel(input, 0, 1);
    assert.strictEqual(result.readInt16LE(0), 100);
    assert.strictEqual(result.readInt16LE(2), 101);
    assert.strictEqual(result.readInt16LE(4), 102);
    assert.strictEqual(result.readInt16LE(6), 103);
  });

  test('returns empty buffer for empty input', () => {
    const result = extractChannel(Buffer.alloc(0), 0, 2);
    assert.strictEqual(result.length, 0);
  });
});

describe('findDataChunk', () => {
  test('finds data chunk offset in a standard WAV', () => {
    // Build a minimal WAV: RIFF header + fmt chunk + data chunk
    const wav = Buffer.alloc(44 + 8); // 44-byte header + 8 bytes of audio
    // RIFF header
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + 8, 4); // file size - 8
    wav.write('WAVE', 8);
    // fmt chunk
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); // chunk size
    // data chunk
    wav.write('data', 36);
    wav.writeUInt32LE(8, 40); // data size

    const offset = findDataChunk(wav);
    assert.strictEqual(offset, 44); // data starts at byte 44
  });

  test('falls back to 44 for WAV without data marker', () => {
    const buf = Buffer.alloc(100, 0);
    const offset = findDataChunk(buf);
    assert.strictEqual(offset, 44);
  });
});

describe('wavToRawPcm', () => {
  test('strips WAV header and returns raw PCM', () => {
    const wav = Buffer.alloc(52); // 44-byte header + 8 bytes audio
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.write('data', 36);
    wav.writeUInt32LE(8, 40);
    // Write some audio data
    for (let i = 0; i < 4; i++) {
      wav.writeInt16LE(i + 1, 44 + i * 2);
    }

    const pcm = wavToRawPcm(wav);
    assert.strictEqual(pcm.length, 8);
    assert.strictEqual(pcm.readInt16LE(0), 1);
    assert.strictEqual(pcm.readInt16LE(2), 2);
    assert.strictEqual(pcm.readInt16LE(4), 3);
    assert.strictEqual(pcm.readInt16LE(6), 4);
  });
});
