'use strict';

/**
 * Focused tests for the VAD module.
 *
 * The VAD depends on browser Web Audio APIs, so this file stubs out the
 * minimal surface (AudioContext, ScriptProcessorNode, GainNode, performance)
 * and drives the VAD's onaudioprocess handler directly with synthetic frames.
 */

var assert = require('assert');

// ---------------------------------------------------------------------------
// Load the module under test (it attaches `VAD` to the global object).
// ---------------------------------------------------------------------------

require('../public/vad.js');
var VAD = global.VAD;
assert.strictEqual(typeof VAD, 'function', 'VAD constructor should be exposed');

// ---------------------------------------------------------------------------
// Minimal browser stubs
// ---------------------------------------------------------------------------

var SAMPLE_RATE = 48000;

function makeAudioContext() {
  var ctx = {
    sampleRate: SAMPLE_RATE,
    state: 'running',
    destination: { _isDestination: true },
    resume: function () { ctx.state = 'running'; return Promise.resolve(); },
    createScriptProcessor: function (bufferSize, inCh, outCh) {
      return {
        bufferSize: bufferSize,
        onaudioprocess: null,
        _outgoing: [],
        connect: function (node) { this._outgoing.push(node); },
        disconnect: function () { this._outgoing = []; },
      };
    },
    createGain: function () {
      return {
        gain: { value: 1 },
        _outgoing: [],
        connect: function (node) { this._outgoing.push(node); },
        disconnect: function () { this._outgoing = []; },
      };
    },
  };
  return ctx;
}

function makeSourceNode() {
  return {
    _outgoing: [],
    connect: function (node) { this._outgoing.push(node); },
    disconnect: function (node) {
      if (node) {
        var idx = this._outgoing.indexOf(node);
        if (idx >= 0) this._outgoing.splice(idx, 1);
      } else {
        this._outgoing = [];
      }
    },
  };
}

/**
 * Build a synthetic AudioProcessingEvent whose input buffer holds the given
 * Float32 samples on channel 0.
 */
function makeEvent(samples) {
  return {
    inputBuffer: {
      getChannelData: function (ch) {
        assert.strictEqual(ch, 0);
        return samples;
      },
    },
  };
}

/**
 * Generate a Float32Array of `count` samples at a given amplitude (sine wave).
 */
function tone(count, amplitude) {
  var buf = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    buf[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  }
  return buf;
}

/** A flat, low-amplitude noise frame (silence). */
function silence(count) {
  var buf = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    buf[i] = 0.001 * (Math.random() * 2 - 1);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Helpers to drive the VAD
// ---------------------------------------------------------------------------

/**
 * Start a VAD and resolve once its ScriptProcessorNode is wired up.
 * Returns the processor node so the caller can dispatch events.
 */
function startVAD(vad) {
  return vad.start().then(function () {
    return vad._processor;
  });
}

/**
 * Feed an array of frames to the processor's onaudioprocess, advancing a
 * fake clock by `frameMs` per frame so time-based logic is deterministic.
 */
function feedFrames(vad, processor, frames, frameMs) {
  var origNow = global.performance.now;
  var t = 0;
  global.performance.now = function () { return t; };
  for (var i = 0; i < frames.length; i++) {
    processor.onaudioprocess(makeEvent(frames[i]));
    t += frameMs;
  }
  global.performance.now = origNow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

var tests = [];

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

// Stub performance.now for deterministic timing.
global.performance = { now: function () { return 0; } };

test('exposes state constants and constructor', function () {
  assert.strictEqual(VAD.STATE_SILENCE, 'SILENCE');
  assert.strictEqual(VAD.STATE_SPEECH, 'SPEECH');
  assert.strictEqual(VAD.STATE_TRAILING_SILENCE, 'TRAILING_SILENCE');
  assert.strictEqual(VAD.BUFFER_SIZE, 4096);
});

test('constructor requires audioContext and sourceNode', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  assert.throws(function () { new VAD(null, src); }, /AudioContext/);
  assert.throws(function () { new VAD(ctx, null); }, /source/);
  // Calling without `new` should still construct.
  var v = VAD(ctx, src);
  assert.ok(v instanceof VAD);
  v.destroy();
});

test('RMS: silence frames stay below default threshold', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({ adaptiveThreshold: false, energyThreshold: 0.01 });

  var silenceCalls = 0;
  vad.onSilence = function () { silenceCalls++; };

  var proc;
  return startVAD(vad).then(function (p) {
    proc = p;
    var frame = silence(4096);
    feedFrames(vad, proc, [frame], 100);
    assert.ok(silenceCalls > 0, 'onSilence should fire for silent frames');
    vad.destroy();
  });
});

test('speech start fires after minSpeechDurationMs', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({
    adaptiveThreshold: false,
    energyThreshold: 0.01,
    minSpeechDurationMs: 200,
    speechPadMs: 0,
  });

  var starts = 0;
  vad.onSpeechStart = function () { starts++; };

  return startVAD(vad).then(function (proc) {
    var loud = tone(4096, 0.5);
    // Each frame is ~85ms at 48kHz; need >200ms of speech to fire start.
    feedFrames(vad, proc, [loud, loud, loud, loud], 85);
    assert.strictEqual(starts, 1, 'onSpeechStart should fire once');
    vad.destroy();
  });
});

test('sub-threshold burst shorter than minSpeechDurationMs does not fire start', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({
    adaptiveThreshold: false,
    energyThreshold: 0.01,
    minSpeechDurationMs: 200,
    silenceTimeoutMs: 1500,
    speechPadMs: 0,
  });

  var starts = 0;
  var ends = 0;
  vad.onSpeechStart = function () { starts++; };
  vad.onSpeechEnd = function () { ends++; };

  return startVAD(vad).then(function (proc) {
    var loud = tone(4096, 0.5);
    var quiet = silence(4096);
    // One loud frame (~85ms) then silence — below the 200ms gate.
    feedFrames(vad, proc, [loud, quiet, quiet], 85);
    assert.strictEqual(starts, 0, 'short burst should not fire onSpeechStart');
    assert.strictEqual(ends, 0, 'short burst should not fire onSpeechEnd');
    vad.destroy();
  });
});

test('endpoint fires after silenceTimeoutMs of trailing silence', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({
    adaptiveThreshold: false,
    energyThreshold: 0.01,
    minSpeechDurationMs: 200,
    silenceTimeoutMs: 1500,
    speechPadMs: 0,
  });

  var starts = 0;
  var ends = 0;
  vad.onSpeechStart = function () { starts++; };
  vad.onSpeechEnd = function () { ends++; };

  return startVAD(vad).then(function (proc) {
    var loud = tone(4096, 0.5);
    var quiet = silence(4096);
    // Enough loud frames to start speech, then enough silence to endpoint.
    var frames = [];
    for (var i = 0; i < 4; i++) frames.push(loud);   // ~340ms speech
    for (var j = 0; j < 20; j++) frames.push(quiet);  // ~1700ms silence
    feedFrames(vad, proc, frames, 85);
    assert.strictEqual(starts, 1, 'speech should start');
    assert.strictEqual(ends, 1, 'endpoint should fire after trailing silence');
    vad.destroy();
  });
});

test('onAudio receives Int16 PCM ArrayBuffer during speech', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({
    adaptiveThreshold: false,
    energyThreshold: 0.01,
    minSpeechDurationMs: 0,
    speechPadMs: 0,
  });

  var chunks = [];
  vad.onAudio = function (buf) {
    assert.ok(buf instanceof ArrayBuffer, 'onAudio should receive ArrayBuffer');
    chunks.push(new Int16Array(buf));
  };

  return startVAD(vad).then(function (proc) {
    var loud = tone(4096, 0.5);
    feedFrames(vad, proc, [loud, loud], 85);
    assert.ok(chunks.length >= 2, 'should emit at least 2 audio chunks');
    // Each Int16 chunk should have 4096 samples.
    assert.strictEqual(chunks[0].length, 4096);
    vad.destroy();
  });
});

test('pre-speech padding is flushed before live audio', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({
    adaptiveThreshold: false,
    energyThreshold: 0.01,
    minSpeechDurationMs: 0,
    speechPadMs: 300,
  });

  var chunks = [];
  vad.onAudio = function (buf) { chunks.push(new Int16Array(buf)); };

  return startVAD(vad).then(function (proc) {
    var quiet = silence(4096);
    var loud = tone(4096, 0.5);
    // Feed 3 silent frames (~255ms, under 300ms pad) then a loud frame.
    feedFrames(vad, proc, [quiet, quiet, quiet, loud], 85);
    // Padding (3 frames) + the live loud frame = 4 chunks minimum.
    assert.ok(chunks.length >= 4, 'padding should be flushed before live audio');
    vad.destroy();
  });
});

test('adaptive threshold calibrates from background noise', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({
    adaptiveThreshold: true,
    energyThreshold: 0.01,
    calibrationMs: 1000,
    minSpeechDurationMs: 0,
    speechPadMs: 0,
  });

  return startVAD(vad).then(function (proc) {
    // Feed ~1200ms of low noise to complete calibration.
    var quiet = silence(4096);
    var frames = [];
    for (var i = 0; i < 15; i++) frames.push(quiet); // ~1275ms
    feedFrames(vad, proc, frames, 85);
    // After calibration the threshold should be max(0.01, noiseRMS * 3).
    assert.ok(vad._calibratedThreshold !== null, 'threshold should be calibrated');
    assert.ok(vad._calibratedThreshold >= 0.01, 'calibrated threshold >= 0.01');
    assert.strictEqual(vad._options.energyThreshold, vad._calibratedThreshold);
    vad.destroy();
  });
});

test('stop and destroy release nodes and prevent further callbacks', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({ adaptiveThreshold: false });

  var starts = 0;
  vad.onSpeechStart = function () { starts++; };

  return startVAD(vad).then(function (proc) {
    vad.stop();
    assert.strictEqual(vad._running, false);
    assert.strictEqual(vad._processor, null, 'processor should be torn down');
    // After stop the processor's handler is nulled, so feeding a frame is a
    // no-op (guard against lingering callbacks).
    assert.strictEqual(proc.onaudioprocess, null, 'handler should be cleared');
    assert.strictEqual(starts, 0, 'no callbacks after stop');
    vad.destroy();
    assert.strictEqual(vad._destroyed, true);
    assert.throws(function () { vad.start(); }, /destroyed/);
  });
});

test('setOptions merges keys without resetting others', function () {
  var ctx = makeAudioContext();
  var src = makeSourceNode();
  var vad = new VAD(ctx, src);
  vad.setOptions({ energyThreshold: 0.05 });
  assert.strictEqual(vad._options.energyThreshold, 0.05);
  // Other defaults should remain.
  assert.strictEqual(vad._options.silenceTimeoutMs, 1500);
  vad.setOptions({ silenceTimeoutMs: 2000 });
  assert.strictEqual(vad._options.energyThreshold, 0.05, 'previous override preserved');
  assert.strictEqual(vad._options.silenceTimeoutMs, 2000);
  vad.destroy();
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function run() {
  var passed = 0;
  var failed = 0;
  var i = 0;

  function next() {
    if (i >= tests.length) {
      console.log('\n' + passed + ' passed, ' + failed + ' failed');
      if (failed > 0) process.exitCode = 1;
      return;
    }
    var t = tests[i++];
    Promise.resolve()
      .then(function () { return t.fn(); })
      .then(function () {
        passed++;
        console.log('  ok - ' + t.name);
      })
      .catch(function (err) {
        failed++;
        console.log('  FAIL - ' + t.name);
        console.log('        ' + (err && err.stack ? err.stack : err));
      })
      .then(next);
  }

  next();
}

run();
