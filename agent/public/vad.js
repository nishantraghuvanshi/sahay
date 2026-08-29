'use strict';

/**
 * Voice Activity Detection (VAD) Module — Browser-Side, Energy-Based
 *
 * Detects speech vs. silence in a microphone audio stream using the Web Audio
 * API. Computes the RMS energy of each audio frame and drives a 3-state
 * machine (SILENCE → SPEECH → TRAILING_SILENCE) to fire speech-start,
 * speech-end (endpointing), and silence callbacks. Audio chunks are emitted
 * only while speech (plus configurable pre-speech padding) is active.
 *
 * Design goals:
 *   - Vanilla JavaScript only — no npm packages, no ES modules.
 *   - Loads as a <script> tag and exposes a global `VAD` constructor.
 *   - Broad browser support via ScriptProcessorNode (not AudioWorklet).
 *   - Does NOT resample audio — it detects speech/silence and passes raw
 *     Float32 audio (converted to Int16 PCM) to the onAudio callback.
 *
 * Usage:
 *   var vad = new VAD(audioContext, sourceNode);
 *   vad.setOptions({ energyThreshold: 0.01, speechPadMs: 300,
 *                    silenceTimeoutMs: 1500, minSpeechDurationMs: 200 });
 *   vad.onSpeechStart = function () { ... };
 *   vad.onSpeechEnd   = function () { ... };
 *   vad.onSilence     = function () { ... };
 *   vad.onAudio       = function (pcmBuffer) { ... };
 *   vad.start();
 *   vad.stop();
 *   vad.destroy();
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** ScriptProcessorNode buffer size (must be a power of 2). */
  var BUFFER_SIZE = 4096;

  /** VAD state enumeration. */
  var STATE_SILENCE = 'SILENCE';
  var STATE_SPEECH = 'SPEECH';
  var STATE_TRAILING_SILENCE = 'TRAILING_SILENCE';

  /** Default options. */
  var DEFAULTS = {
    // RMS threshold above which a frame is considered speech.
    energyThreshold: 0.01,
    // Milliseconds of audio to include before speech is detected (padding).
    speechPadMs: 300,
    // Milliseconds of trailing silence before an endpoint is declared.
    silenceTimeoutMs: 1500,
    // Ignore speech bursts shorter than this (noise rejection).
    minSpeechDurationMs: 200,
    // When true, calibrate the threshold from background noise during the
    // first second after start().
    adaptiveThreshold: true,
    // Calibration window in milliseconds.
    calibrationMs: 1000,
  };

  // ---------------------------------------------------------------------------
  // VAD constructor
  // ---------------------------------------------------------------------------

  /**
   * Create a VAD instance.
   *
   * @param {AudioContext} audioContext - a live AudioContext
   * @param {AudioNode} sourceNode - node whose audio to analyse (e.g. a
   *   MediaStreamSource). Must be connected (or connectable) to the
   *   ScriptProcessorNode this module creates.
   */
  function VAD(audioContext, sourceNode) {
    if (!(this instanceof VAD)) {
      return new VAD(audioContext, sourceNode);
    }

    if (!audioContext) {
      throw new Error('VAD: an AudioContext is required');
    }
    if (!sourceNode) {
      throw new Error('VAD: a source AudioNode is required');
    }

    this._audioContext = audioContext;
    this._sourceNode = sourceNode;

    // Merge defaults with an empty override set; callers use setOptions().
    this._options = mergeOptions(DEFAULTS, {});

    // Callbacks (assigned by the caller).
    this.onSpeechStart = null;
    this.onSpeechEnd = null;
    this.onSilence = null;
    this.onAudio = null;

    // Runtime state.
    this._state = STATE_SILENCE;
    this._running = false;
    this._destroyed = false;

    // Rolling pre-speech padding buffer (array of Float32Array chunks).
    this._padChunks = [];
    this._padDurationMs = 0;

    // Timing bookkeeping for the state machine.
    this._silenceStartTs = 0;   // when trailing silence began
    this._speechStartTs = 0;    // when the current speech burst began
    this._emittedSpeechStart = false; // guards minSpeechDurationMs noise rejection

    // Adaptive-threshold calibration.
    this._calibrating = false;
    this._calibrationStartTs = 0;
    this._calibrationSum = 0;
    this._calibrationFrames = 0;
    this._calibratedThreshold = null;

    // ScriptProcessorNode + mute gain (created on start()).
    this._processor = null;
    this._muteGain = null;

    // Bound handler so we can remove it on stop()/destroy().
    this._onAudioProcess = this._handleAudioProcess.bind(this);
  }

  // Expose state constants on the constructor for introspection/testing.
  VAD.STATE_SILENCE = STATE_SILENCE;
  VAD.STATE_SPEECH = STATE_SPEECH;
  VAD.STATE_TRAILING_SILENCE = STATE_TRAILING_SILENCE;
  VAD.BUFFER_SIZE = BUFFER_SIZE;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * Update one or more options. Only the supplied keys are changed.
   *
   * @param {Object} opts
   * @param {number} [opts.energyThreshold]
   * @param {number} [opts.speechPadMs]
   * @param {number} [opts.silenceTimeoutMs]
   * @param {number} [opts.minSpeechDurationMs]
   * @param {boolean} [opts.adaptiveThreshold]
   * @param {number} [opts.calibrationMs]
   */
  VAD.prototype.setOptions = function (opts) {
    if (!opts) return;
    this._options = mergeOptions(this._options, opts);
  };

  // ---------------------------------------------------------------------------
  // Lifecycle: start / stop / destroy
  // ---------------------------------------------------------------------------

  /**
   * Begin VAD processing. Creates a ScriptProcessorNode, connects the source
   * through it to a zero-gain node (to avoid echo), and starts the state
   * machine. If the AudioContext is suspended, attempts to resume it.
   *
   * @returns {Promise<void>} resolves once processing has started
   */
  VAD.prototype.start = function () {
    if (this._destroyed) {
      throw new Error('VAD: cannot start a destroyed instance');
    }
    if (this._running) return Promise.resolve();

    var self = this;
    var ctx = this._audioContext;

    // The AudioContext may be suspended under browser autoplay policies; a
    // user gesture (e.g. clicking "start") is required to resume it.
    var resumeP = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();

    return resumeP.then(function () {
      if (self._destroyed) return;

      // Reset runtime state for a fresh run.
      self._resetState();

      // Create the ScriptProcessorNode (1 input, 1 output channel).
      self._processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      self._processor.onaudioprocess = self._onAudioProcess;

      // Route through a zero-gain node so mic audio never reaches the
      // speakers (prevents echo/feedback while the agent is speaking).
      self._muteGain = ctx.createGain();
      self._muteGain.gain.value = 0;

      self._sourceNode.connect(self._processor);
      self._processor.connect(self._muteGain);
      self._muteGain.connect(ctx.destination);

      self._running = true;

      // Begin adaptive-threshold calibration if enabled.
      if (self._options.adaptiveThreshold) {
        self._calibrating = true;
        self._calibrationStartTs = nowMs();
        self._calibrationSum = 0;
        self._calibrationFrames = 0;
      }
    });
  };

  /**
   * Stop VAD processing. Disconnects the processor and clears timers but
   * leaves the instance reusable (start() can be called again).
   */
  VAD.prototype.stop = function () {
    if (!this._running) return;

    this._running = false;
    this._teardownNodes();
    this._resetState();
  };

  /**
   * Stop processing and release all resources. The instance is no longer
   * usable after this call.
   */
  VAD.prototype.destroy = function () {
    if (this._destroyed) return;

    this.stop();
    this._destroyed = true;

    // Drop references so they can be garbage-collected.
    this._audioContext = null;
    this._sourceNode = null;
    this._options = null;
    this.onSpeechStart = null;
    this.onSpeechEnd = null;
    this.onSilence = null;
    this.onAudio = null;
  };

  // ---------------------------------------------------------------------------
  // Internal: node teardown & state reset
  // ---------------------------------------------------------------------------

  /**
   * Disconnect the ScriptProcessorNode and mute gain, and null the
   * onaudioprocess handler to prevent lingering callbacks / leaks.
   */
  VAD.prototype._teardownNodes = function () {
    if (this._processor) {
      try { this._sourceNode.disconnect(this._processor); } catch (e) { /* ignore */ }
      try { this._processor.disconnect(); } catch (e) { /* ignore */ }
      this._processor.onaudioprocess = null;
      this._processor = null;
    }
    if (this._muteGain) {
      try { this._muteGain.disconnect(); } catch (e) { /* ignore */ }
      this._muteGain = null;
    }
  };

  /**
   * Reset the state machine and all per-run bookkeeping to their initial
   * values. Called on start() and stop().
   */
  VAD.prototype._resetState = function () {
    this._state = STATE_SILENCE;
    this._padChunks = [];
    this._padDurationMs = 0;
    this._silenceStartTs = 0;
    this._speechStartTs = 0;
    this._emittedSpeechStart = false;
    this._calibrating = false;
    this._calibrationStartTs = 0;
    this._calibrationSum = 0;
    this._calibrationFrames = 0;
  };

  // ---------------------------------------------------------------------------
  // Internal: audio processing
  // ---------------------------------------------------------------------------

  /**
   * onaudioprocess handler. Computes RMS, updates calibration, drives the
   * state machine, and emits audio/callbacks as appropriate.
   *
   * @param {AudioProcessingEvent} event
   */
  VAD.prototype._handleAudioProcess = function (event) {
    if (!this._running || this._destroyed) return;

    var inputBuffer = event.inputBuffer;
    var channelData = inputBuffer.getChannelData(0);

    // Copy the frame so we own it beyond this callback (the underlying
    // buffer is reused by the browser).
    var samples = new Float32Array(channelData.length);
    samples.set(channelData);

    var rms = computeRMS(samples);
    var frameMs = (samples.length / this._audioContext.sampleRate) * 1000;

    // Adaptive-threshold calibration takes priority during its window.
    if (this._calibrating) {
      this._updateCalibration(rms);
      // While calibrating, still feed the padding buffer but suppress speech
      // detection so background noise doesn't trigger a false start.
      this._pushPadding(samples, frameMs);
      return;
    }

    this._driveStateMachine(rms, samples, frameMs);
  };

  /**
   * Accumulate RMS samples during the calibration window, then set the
   * adaptive threshold to max(0.01, backgroundNoiseRMS * 3).
   *
   * @param {number} rms - RMS of the current frame
   */
  VAD.prototype._updateCalibration = function (rms) {
    this._calibrationSum += rms;
    this._calibrationFrames += 1;

    var elapsed = nowMs() - this._calibrationStartTs;
    if (elapsed >= this._options.calibrationMs) {
      var avgNoise = this._calibrationFrames > 0
        ? this._calibrationSum / this._calibrationFrames
        : 0;
      var adaptive = Math.max(0.01, avgNoise * 3);
      this._calibratedThreshold = adaptive;
      // Apply the calibrated threshold immediately.
      this._options.energyThreshold = adaptive;
      this._calibrating = false;
    }
  };

  /**
   * Core state-machine driver. Transitions between SILENCE, SPEECH, and
   * TRAILING_SILENCE, firing callbacks and emitting audio as needed.
   *
   * @param {number} rms - RMS of the current frame
   * @param {Float32Array} samples - the audio frame
   * @param {number} frameMs - duration of the frame in milliseconds
   */
  VAD.prototype._driveStateMachine = function (rms, samples, frameMs) {
    var threshold = this._options.energyThreshold;
    var isSpeech = rms > threshold;
    var ts = nowMs();

    switch (this._state) {

      case STATE_SILENCE:
        // Always maintain the padding buffer so speech start can flush it.
        this._pushPadding(samples, frameMs);

        if (isSpeech) {
          // Transition into speech.
          this._state = STATE_SPEECH;
          this._speechStartTs = ts;
          this._emittedSpeechStart = false;

          // Flush the pre-speech padding buffer first, then this frame.
          this._flushPadding();

          // Emit the current frame as audio.
          this._emitAudio(samples);

          // Fire onSpeechStart only after the speech survives the minimum
          // duration gate (handled below); for now we note the start time.
          this._maybeFireSpeechStart(ts);
        } else {
          // Still silent.
          if (typeof this.onSilence === 'function') {
            this.onSilence();
          }
        }
        break;

      case STATE_SPEECH:
        if (isSpeech) {
          // Stay in speech; emit audio.
          this._emitAudio(samples);
          this._maybeFireSpeechStart(ts);
        } else {
          // Start trailing silence.
          this._state = STATE_TRAILING_SILENCE;
          this._silenceStartTs = ts;
          // Still emit the trailing audio (it may be part of the utterance).
          this._emitAudio(samples);
        }
        break;

      case STATE_TRAILING_SILENCE:
        if (isSpeech) {
          // Speech resumed — cancel the endpoint timer.
          this._state = STATE_SPEECH;
          this._silenceStartTs = 0;
          this._emitAudio(samples);
          this._maybeFireSpeechStart(ts);
        } else {
          // Continue trailing silence; emit audio until the endpoint fires.
          this._emitAudio(samples);

          var silenceElapsed = ts - this._silenceStartTs;
          if (silenceElapsed >= this._options.silenceTimeoutMs) {
            // Endpoint detected.
            this._fireSpeechEnd();
            this._state = STATE_SILENCE;
            this._emittedSpeechStart = false;
            this._speechStartTs = 0;
            this._silenceStartTs = 0;
            // Begin collecting padding for the next utterance.
            this._pushPadding(samples, frameMs);
          }
        }
        break;

      default:
        // Defensive: unknown state — reset to SILENCE.
        this._state = STATE_SILENCE;
        break;
    }
  };

  // ---------------------------------------------------------------------------
  // Internal: padding buffer
  // ---------------------------------------------------------------------------

  /**
   * Push a frame into the rolling pre-speech padding buffer, evicting the
   * oldest chunks once the buffer exceeds speechPadMs.
   *
   * @param {Float32Array} samples
   * @param {number} frameMs
   */
  VAD.prototype._pushPadding = function (samples, frameMs) {
    this._padChunks.push(samples);
    this._padDurationMs += frameMs;

    // Evict oldest chunks until we're within the padding budget.
    var budget = this._options.speechPadMs;
    while (this._padDurationMs > budget && this._padChunks.length > 1) {
      var oldest = this._padChunks.shift();
      this._padDurationMs -= (oldest.length / this._audioContext.sampleRate) * 1000;
    }
  };

  /**
   * Flush the padding buffer via onAudio and clear it. Called when speech
   * starts so the recipient receives the lead-in audio first.
   */
  VAD.prototype._flushPadding = function () {
    for (var i = 0; i < this._padChunks.length; i++) {
      this._emitAudio(this._padChunks[i]);
    }
    this._padChunks = [];
    this._padDurationMs = 0;
  };

  // ---------------------------------------------------------------------------
  // Internal: audio emission & callbacks
  // ---------------------------------------------------------------------------

  /**
   * Convert a Float32 frame to Int16 PCM and deliver it via onAudio, but
   * only if onSpeechStart has fired (or is about to). During the
   * minSpeechDurationMs gate we still emit audio so it isn't lost.
   *
   * @param {Float32Array} samples
   */
  VAD.prototype._emitAudio = function (samples) {
    if (typeof this.onAudio !== 'function') return;
    var pcm = floatTo16BitPCM(samples);
    this.onAudio(pcm);
  };

  /**
   * Fire onSpeechStart once the current speech burst has lasted at least
   * minSpeechDurationMs. This rejects brief noise spikes.
   *
   * @param {number} ts - current timestamp (ms)
   */
  VAD.prototype._maybeFireSpeechStart = function (ts) {
    if (this._emittedSpeechStart) return;
    var elapsed = ts - this._speechStartTs;
    if (elapsed >= this._options.minSpeechDurationMs) {
      this._emittedSpeechStart = true;
      if (typeof this.onSpeechStart === 'function') {
        this.onSpeechStart();
      }
    }
  };

  /**
   * Fire onSpeechEnd, but only if onSpeechStart was actually emitted (so a
   * sub-threshold noise burst doesn't produce a spurious end event).
   */
  VAD.prototype._fireSpeechEnd = function () {
    if (!this._emittedSpeechStart) return;
    if (typeof this.onSpeechEnd === 'function') {
      this.onSpeechEnd();
    }
  };

  // ---------------------------------------------------------------------------
  // Internal: helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute the RMS (root mean square) energy of an audio frame.
   *
   * @param {Float32Array} buffer - samples in [-1, 1]
   * @returns {number}
   */
  function computeRMS(buffer) {
    var sum = 0;
    for (var i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  /**
   * Convert a Float32Array to a 16-bit PCM ArrayBuffer (little-endian Int16).
   *
   * @param {Float32Array} float32Array - samples in [-1, 1]
   * @returns {ArrayBuffer}
   */
  function floatTo16BitPCM(float32Array) {
    var buffer = new ArrayBuffer(float32Array.length * 2);
    var view = new DataView(buffer);

    for (var i = 0; i < float32Array.length; i++) {
      // Clamp to [-1, 1] and convert to the signed 16-bit range.
      var sample = Math.max(-1, Math.min(1, float32Array[i]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(i * 2, sample, true); // little-endian
    }

    return buffer;
  }

  /**
   * Shallow-merge override keys into a copy of the base options object.
   *
   * @param {Object} base
   * @param {Object} overrides
   * @returns {Object}
   */
  function mergeOptions(base, overrides) {
    var result = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        result[key] = base[key];
      }
    }
    for (key in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  /**
   * Current timestamp in milliseconds (monotonic-ish via performance.now when
   * available, else Date.now).
   *
   * @returns {number}
   */
  function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  // Expose the constructor globally. In a browser <script> tag this is
  // `window`; under Node's CommonJS it is `global` (so tests can require it).
  global.VAD = VAD;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
