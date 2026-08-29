'use strict';

/**
 * Voice Agent Playground — Browser Client
 *
 * Captures microphone audio, streams it to the bridge server over WebSocket
 * as raw 16-bit PCM (16 kHz, mono), and plays back the agent's TTS audio.
 *
 * A Voice Activity Detection (VAD) module gates audio sending so that PCM is
 * only transmitted while speech is detected. Barge-in (user speaking while
 * the agent speaks) cancels TTS playback and notifies the server.
 *
 * Protocol (browser → server):
 *   - Text frames (JSON):  { type: "start", language, phone, direction }
 *                           { type: "stop" }               // ends the session as "dropped" — resumable
 *                           { type: "barge-in" }          // user interrupted agent
 *                           { type: "speech-detected" }    // VAD detected speech
 *                           { type: "silence-detected" }   // VAD endpoint (user stopped)
 *   - Binary frames:       raw Int16 PCM, 16 kHz, mono (only during speech)
 *
 * `phone` picks a seeded patient (see loadPatients / GET /api/playground/patients);
 * `direction` is "inbound" or "outbound". The server resolves these to a
 * mode ("outbound" | "inbound" | "resume") the same way a phone call would.
 *
 * Protocol (server → browser, JSON text frames):
 *   { type: "transcript", text, isFinal }
 *   { type: "agent_response", text }
 *   { type: "audio", data: "<base64 PCM>" }   // 16-bit, 16 kHz, mono
 *   { type: "outcome", label, reason }
 *   { type: "status", state: "idle"|"listening"|"thinking"|"speaking" }
 *   { type: "mode", mode: "outbound"|"inbound"|"resume" }
 *   { type: "error", message }
 *
 * No external dependencies — vanilla JS loaded via a <script> tag.
 * The VAD module is loaded via a separate <script> tag and exposes a global
 * `VAD` constructor. If it is not available, the client falls back to
 * continuous audio sending (no VAD gating).
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Target sample rate for STT input (Hz). */
  const TARGET_SAMPLE_RATE = 16000;
  /** Sample rate of TTS audio received from the server (Hz). */
  const PLAYBACK_SAMPLE_RATE = 16000;
  /** ScriptProcessor buffer size (must be a power of 2). */
  const PROCESSOR_BUFFER_SIZE = 4096;

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const patientSelect = document.getElementById('patientSelect');
  const directionSelect = document.getElementById('directionSelect');
  const languageSelect = document.getElementById('language');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const modeBadge = document.getElementById('modeBadge');
  const transcriptEl = document.getElementById('transcript');
  const errorBox = document.getElementById('errorBox');
  const outcomeBox = document.getElementById('outcomeBox');

  // ---------------------------------------------------------------------------
  // Runtime state
  // ---------------------------------------------------------------------------

  let ws = null;
  let audioContext = null;
  let mediaStream = null;
  let mediaStreamSource = null;
  /** ScriptProcessorNode — only used in the fallback (no-VAD) path. */
  let scriptProcessor = null;
  /** VAD instance — null when VAD is unavailable or not yet started. */
  let vad = null;

  /** True while the user has actively started a session (not yet stopped). */
  let isRunning = false;

  /** Reference to the partial-transcript DOM element, if one is on screen. */
  let partialMessageEl = null;

  /** Queue of AudioBuffers awaiting playback, plus a "now playing" flag. */
  const playbackQueue = [];
  let isPlaying = false;
  /** The AudioBufferSourceNode currently playing, so it can be cancelled. */
  let currentAudioSource = null;

  /** True while the agent is speaking TTS audio (enables barge-in). */
  let agentSpeaking = false;

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  /**
   * Build the WebSocket URL for the playground endpoint.
   * Uses the current page's host so it works on non-localhost deployments.
   * Appends the API key as a query param if one is configured.
   * @returns {string}
   */
  function buildWebSocketUrl() {
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    // On localhost the bridge server runs on port 3001; elsewhere use the
    // same host/port that served the page (reverse-proxied deployments).
    const host =
      loc.hostname === 'localhost' || loc.hostname === '127.0.0.1'
        ? 'localhost:3001'
        : loc.host;
    let url = `${protocol}//${host}/playground`;

    // Append API key if configured in a meta tag or global variable
    const apiKey =
      (typeof PLAYGROUND_API_KEY !== 'undefined' && PLAYGROUND_API_KEY) ||
      document.querySelector('meta[name="api-key"]')?.content;
    if (apiKey) {
      url += `?api_key=${encodeURIComponent(apiKey)}`;
    }

    return url;
  }

  /**
   * Connect to the playground WebSocket. Resolves once open, rejects on error.
   * @returns {Promise<WebSocket>}
   */
  function connectWebSocket() {
    return new Promise((resolve, reject) => {
      // Clean up any existing socket before creating a new one (handles the
      // case where a previous attempt is still CONNECTING or CLOSING).
      if (ws) {
        ws.removeEventListener('close', handleWebSocketClose);
        ws.removeEventListener('message', handleServerMessage);
        try { ws.close(); } catch (e) { /* ignore */ }
        ws = null;
      }

      const url = buildWebSocketUrl();
      let socket;

      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      socket.binaryType = 'arraybuffer';

      socket.addEventListener('open', () => resolve(socket));

      socket.addEventListener('error', () => {
        // The close event usually follows with more detail; surface a friendly
        // message here in case close never fires.
        showError('Could not connect to server. Make sure the bridge server is running.');
        reject(new Error('WebSocket connection failed'));
      });

      socket.addEventListener('message', handleServerMessage);

      socket.addEventListener('close', handleWebSocketClose);

      ws = socket;
    });
  }

  /**
   * Send a JSON object as a text frame.
   * @param {Object} message
   */
  function sendJSON(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send raw PCM audio as a binary frame.
   * @param {ArrayBuffer} arrayBuffer
   */
  function sendAudio(arrayBuffer) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(arrayBuffer);
    }
  }

  /**
   * Handle an unexpected WebSocket close: reset UI and notify the user.
   * @param {CloseEvent} event
   */
  function handleWebSocketClose(event) {
    // Only treat as unexpected if the user hasn't stopped intentionally.
    if (isRunning) {
      showError('Connection to server was lost.');
    }
    resetUI();
  }

  // ---------------------------------------------------------------------------
  // Server message handling
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a single server message.
   * @param {MessageEvent} event
   */
  function handleServerMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.error('Invalid message from server:', err);
      return;
    }

    switch (message.type) {
      case 'status':
        updateStatus(message.state);
        break;
      case 'mode':
        updateModeBadge(message.mode);
        break;
      case 'transcript':
        handleTranscript(message.text, message.isFinal);
        break;
      case 'agent_response':
        appendMessage('agent', message.text);
        break;
      case 'audio':
        handleIncomingAudio(message.data);
        break;
      case 'outcome':
        showOutcome(message.label, message.reason);
        break;
      case 'error':
        showError(message.message);
        break;
      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  /**
   * Update the status indicator and track the agent-speaking state.
   * @param {"idle"|"listening"|"thinking"|"speaking"} state
   */
  function updateStatus(state) {
    // Clear any previous state class, keep the base "status" class.
    statusEl.classList.remove('listening', 'thinking', 'speaking');

    const labels = {
      idle: 'Idle',
      listening: 'Listening...',
      thinking: 'Thinking...',
      speaking: 'Speaking...',
    };

    if (state !== 'idle') {
      statusEl.classList.add(state);
    }
    statusText.textContent = labels[state] || 'Idle';

    // Track whether the agent is speaking so the VAD can detect barge-in.
    agentSpeaking = state === 'speaking';
  }

  /**
   * Show (or hide) the resolved-mode badge — the whole point of the
   * playground transport is being able to see resume engage.
   * @param {"outbound"|"inbound"|"resume"|null} mode
   */
  function updateModeBadge(mode) {
    if (!mode) {
      modeBadge.classList.remove('visible');
      modeBadge.textContent = '';
      return;
    }
    const labels = { outbound: 'Outbound', inbound: 'Inbound', resume: 'Resumed' };
    modeBadge.textContent = `Mode: ${labels[mode] || mode}`;
    modeBadge.classList.add('visible');
  }

  /**
   * Handle a transcript message. Partial results update the same element;
   * final results replace the partial with non-italic text.
   * @param {string} text
   * @param {boolean} isFinal
   */
  function handleTranscript(text, isFinal) {
    if (!isFinal) {
      // Reuse the existing partial element, or create one.
      if (!partialMessageEl) {
        partialMessageEl = appendMessage('user', text, true);
      } else {
        partialMessageEl.querySelector('.text').textContent = text;
      }
    } else {
      // Replace the partial (if any) with the final transcript.
      if (partialMessageEl) {
        partialMessageEl.querySelector('.text').textContent = text;
        partialMessageEl.querySelector('.text').classList.remove('partial');
        partialMessageEl = null;
      } else {
        appendMessage('user', text, false);
      }
    }
  }

  /**
   * Append a message to the transcript box.
   * @param {"user"|"agent"} role
   * @param {string} text
   * @param {boolean} [isPartial=false] - render as italic/gray partial text
   * @returns {HTMLDivElement} The created message element.
   */
  function appendMessage(role, text, isPartial) {
    // Remove the initial hint on first real message.
    const hint = transcriptEl.querySelector('.hint');
    if (hint) hint.remove();

    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;

    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = role === 'user' ? 'You' : 'Agent';

    const textEl = document.createElement('div');
    textEl.className = 'text';
    if (isPartial) textEl.classList.add('partial');
    textEl.textContent = text;

    messageEl.appendChild(roleEl);
    messageEl.appendChild(textEl);
    transcriptEl.appendChild(messageEl);

    // Auto-scroll to the newest message.
    transcriptEl.scrollTop = transcriptEl.scrollHeight;

    return messageEl;
  }

  /**
   * Show an outcome banner.
   * @param {string} label - CONFIRMED, DENIED, ESCALATED, NO_ANSWER
   * @param {string} reason
   */
  function showOutcome(label, reason) {
    outcomeBox.className = `outcome ${label}`;
    outcomeBox.textContent = reason ? `${label}: ${reason}` : label;
  }

  /**
   * Show an error message in the error box.
   * @param {string} message
   */
  function showError(message) {
    errorBox.className = 'error';
    errorBox.textContent = message;
  }

  /**
   * Clear the error box.
   */
  function clearError() {
    errorBox.className = '';
    errorBox.textContent = '';
  }

  // ---------------------------------------------------------------------------
  // Microphone capture
  // ---------------------------------------------------------------------------

  /**
   * Request microphone access and begin streaming audio to the server.
   *
   * If the VAD module is available, a VAD instance is created to gate audio
   * sending (only during speech) and detect barge-in / endpoints. If VAD is
   * not available, falls back to continuous sending via a ScriptProcessorNode.
   *
   * @returns {Promise<void>}
   */
  async function startMicrophone() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      showError(
        'Microphone access denied. Please allow microphone access and try again.'
      );
      throw err;
    }

    mediaStream = stream;

    // Reuse a single AudioContext (also used for playback).
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume in case the context was suspended (autoplay policy).
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    mediaStreamSource = audioContext.createMediaStreamSource(stream);

    if (typeof VAD !== 'undefined') {
      // --- VAD mode: speech-gated audio sending ---
      setupVAD();
      await vad.start();
    } else {
      // --- Fallback: continuous audio sending (no VAD) ---
      console.warn('VAD module not loaded — falling back to continuous audio sending.');
      setupFallbackAudio();
    }
  }

  /**
   * Create the VAD instance and wire up its callbacks for speech-gated
   * audio sending, barge-in detection, and endpointing.
   */
  function setupVAD() {
    vad = new VAD(audioContext, mediaStreamSource);

    // User started speaking.
    vad.onSpeechStart = function () {
      // If the agent is speaking, this is a barge-in: cancel TTS and notify.
      if (agentSpeaking) {
        sendJSON({ type: 'barge-in' });
        cancelTTS();
        updateStatus('listening');
      }
      // Notify the server that speech has started (resets its silence timer).
      sendJSON({ type: 'speech-detected' });
    };

    // User stopped speaking (endpoint detected by trailing silence).
    vad.onSpeechEnd = function () {
      sendJSON({ type: 'silence-detected' });
    };

    // Audio chunk captured during speech — resample to 16 kHz and send.
    vad.onAudio = function (pcmBuffer) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // pcmBuffer is Int16 PCM at the AudioContext sample rate.
        // Convert to Float32, resample to 16 kHz, convert back to Int16 PCM.
        var float32 = int16ToFloat32(pcmBuffer);
        var resampled = downsampleBuffer(
          float32,
          audioContext.sampleRate,
          TARGET_SAMPLE_RATE
        );
        var pcm16 = floatTo16BitPCM(resampled);
        sendAudio(pcm16);
      }
    };
  }

  /**
   * Fallback audio capture without VAD: a ScriptProcessorNode continuously
   * resamples and sends every audio frame to the server.
   */
  function setupFallbackAudio() {
    // ScriptProcessorNode is deprecated but has the widest browser support
    // and is the simplest approach for capturing raw PCM here.
    scriptProcessor = audioContext.createScriptProcessor(
      PROCESSOR_BUFFER_SIZE,
      1,
      1
    );

    scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
      const inputBuffer = audioProcessingEvent.inputBuffer;
      const channelData = inputBuffer.getChannelData(0);

      // Resample from the AudioContext rate (44100/48000) to 16 kHz, then
      // convert to 16-bit PCM and send as a binary frame.
      const downsampled = downsampleBuffer(
        channelData,
        audioContext.sampleRate,
        TARGET_SAMPLE_RATE
      );
      const pcm = floatTo16BitPCM(downsampled);
      sendAudio(pcm);
    };

    mediaStreamSource.connect(scriptProcessor);
    // ScriptProcessorNode must connect to a destination to fire onaudioprocess,
    // but we route through a zero-gain node so the mic audio never reaches the
    // speakers (prevents echo/feedback while the agent is speaking).
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    scriptProcessor.connect(muteGain);
    muteGain.connect(audioContext.destination);
  }

  /**
   * Stop microphone capture and release related resources.
   * Destroys the VAD instance if one is active, or tears down the fallback
   * ScriptProcessorNode otherwise.
   */
  function stopMicrophone() {
    if (vad) {
      try { vad.destroy(); } catch (e) { /* ignore */ }
      vad = null;
    }
    if (scriptProcessor) {
      scriptProcessor.disconnect();
      scriptProcessor.onaudioprocess = null;
      scriptProcessor = null;
    }
    if (mediaStreamSource) {
      try { mediaStreamSource.disconnect(); } catch (e) { /* ignore */ }
      mediaStreamSource = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  // ---------------------------------------------------------------------------
  // TTS playback cancellation
  // ---------------------------------------------------------------------------

  /**
   * Cancel any currently playing or queued TTS audio.
   * Stops the active AudioBufferSourceNode, clears the playback queue, and
   * marks the agent as no longer speaking. Called on barge-in and shutdown.
   */
  function cancelTTS() {
    if (currentAudioSource) {
      try { currentAudioSource.stop(); } catch (e) { /* already stopped */ }
      currentAudioSource = null;
    }
    playbackQueue.length = 0;
    isPlaying = false;
    agentSpeaking = false;
  }

  // ---------------------------------------------------------------------------
  // Audio playback
  // ---------------------------------------------------------------------------

  /**
   * Decode a base64 PCM string and queue it for sequential playback.
   * @param {string} base64Pcm - base64-encoded raw 16-bit PCM, 16 kHz, mono
   */
  function handleIncomingAudio(base64Pcm) {
    const arrayBuffer = base64ToArrayBuffer(base64Pcm);
    playPcm(arrayBuffer);
  }

  /**
   * Create an AudioBuffer from raw 16-bit PCM and enqueue it for playback.
   * Chunks play sequentially without overlapping.
   * @param {ArrayBuffer} pcm16 - raw 16-bit PCM at PLAYBACK_SAMPLE_RATE, mono
   */
  function playPcm(pcm16) {
    if (!audioContext) return;

    const int16 = new Int16Array(pcm16);
    const float32 = new Float32Array(int16.length);

    // Convert Int16 samples (-32768..32767) to Float32 (-1..1).
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const audioBuffer = audioContext.createBuffer(
      1,
      float32.length,
      PLAYBACK_SAMPLE_RATE
    );
    audioBuffer.copyToChannel(float32, 0);

    playbackQueue.push(audioBuffer);
    drainPlaybackQueue();
  }

  /**
   * Play queued audio buffers one at a time. Each buffer is played via an
   * AudioBufferSourceNode whose reference is retained so playback can be
   * cancelled mid-stream (barge-in).
   */
  function drainPlaybackQueue() {
    if (isPlaying || playbackQueue.length === 0) return;

    const buffer = playbackQueue.shift();
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    currentAudioSource = source;
    isPlaying = true;

    source.onended = () => {
      // Only advance the queue if this source has not been cancelled by
      // cancelTTS() (which nulls currentAudioSource before stopping).
      if (currentAudioSource === source) {
        currentAudioSource = null;
        isPlaying = false;
        // Play the next queued chunk, if any.
        drainPlaybackQueue();
      }
    };

    source.start();
  }

  // ---------------------------------------------------------------------------
  // Audio conversion helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert an Int16 PCM ArrayBuffer to a Float32Array (samples in [-1, 1]).
   * Used to resample VAD audio output before sending to the server.
   * @param {ArrayBuffer} arrayBuffer - raw 16-bit PCM
   * @returns {Float32Array}
   */
  function int16ToFloat32(arrayBuffer) {
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);

    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    return float32;
  }

  /**
   * Downsample a Float32 buffer from one sample rate to another using linear
   * interpolation. Returns a new Float32Array at the target rate.
   * @param {Float32Array} buffer - input samples in [-1, 1]
   * @param {number} fromSampleRate
   * @param {number} toSampleRate
   * @returns {Float32Array}
   */
  function downsampleBuffer(buffer, fromSampleRate, toSampleRate) {
    if (toSampleRate === fromSampleRate) {
      return buffer;
    }
    if (toSampleRate > fromSampleRate) {
      throw new Error('Upsampling is not supported.');
    }

    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const position = i * ratio;
      const leftIndex = Math.floor(position);
      const rightIndex = Math.min(leftIndex + 1, buffer.length - 1);
      const fraction = position - leftIndex;

      // Linear interpolation between adjacent samples.
      result[i] =
        buffer[leftIndex] * (1 - fraction) + buffer[rightIndex] * fraction;
    }

    return result;
  }

  /**
   * Convert a Float32Array to a 16-bit PCM ArrayBuffer (little-endian Int16).
   * @param {Float32Array} float32Array - samples in [-1, 1]
   * @returns {ArrayBuffer}
   */
  function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
      // Clamp and convert to signed 16-bit range.
      let sample = Math.max(-1, Math.min(1, float32Array[i]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(i * 2, sample, true); // little-endian
    }

    return buffer;
  }

  /**
   * Decode a base64 string into an ArrayBuffer.
   * Handles characters outside the Latin1 range by decoding in chunks.
   * @param {string} base64
   * @returns {ArrayBuffer}
   */
  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const length = binaryString.length;
    const bytes = new Uint8Array(length);

    for (let i = 0; i < length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  }

  // ---------------------------------------------------------------------------
  // Patient picker
  // ---------------------------------------------------------------------------

  /**
   * Load the seeded patient list from the server and populate the picker.
   * Falls back to a disabled placeholder on failure rather than blocking
   * the rest of the page.
   */
  async function loadPatients() {
    try {
      // Same key the WebSocket connect sends (see connect()); this endpoint
      // is auth-guarded, so the picker needs it too when API_KEY is set.
      const key =
        (typeof PLAYGROUND_API_KEY !== 'undefined' && PLAYGROUND_API_KEY) ||
        document.querySelector('meta[name="api-key"]')?.content;
      const url = key
        ? `/api/playground/patients?api_key=${encodeURIComponent(key)}`
        : '/api/playground/patients';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const { patients } = await res.json();

      patientSelect.innerHTML = '';
      if (!patients || patients.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No seeded patients found';
        patientSelect.appendChild(opt);
        return;
      }

      for (const patient of patients) {
        const opt = document.createElement('option');
        opt.value = patient.phone_e164;
        opt.textContent = `${patient.name || '(no name)'} — ${patient.phone_e164}`;
        patientSelect.appendChild(opt);
      }
    } catch (err) {
      console.error('Failed to load patients:', err);
      patientSelect.innerHTML = '<option value="">Could not load patients</option>';
    }
  }

  // ---------------------------------------------------------------------------
  // Start / Stop flow
  // ---------------------------------------------------------------------------

  /**
   * Start a conversation: connect, request mic, and notify the server.
   */
  async function startConversation() {
    clearError();
    // Clear any previous outcome banner and mode badge.
    outcomeBox.className = '';
    outcomeBox.textContent = '';
    updateModeBadge(null);

    const language = languageSelect.value || 'hi';
    const phone = patientSelect.value;
    const direction = directionSelect.value || 'inbound';

    if (!phone) {
      showError('Pick a patient before starting.');
      return;
    }

    try {
      // 1. Connect WebSocket (if not already open).
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        await connectWebSocket();
      }

      // 2. Request microphone access and begin streaming.
      await startMicrophone();

      // 3. Tell the server to start the conversation.
      sendJSON({ type: 'start', language, phone, direction });

      // 4. Update UI state.
      isRunning = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } catch (err) {
      console.error('Failed to start conversation:', err);
      // Error message already shown by the relevant helper.
      resetUI();
    }
  }

  /**
   * Stop the conversation: notify the server, stop mic, cancel TTS, and
   * close the socket.
   */
  function stopConversation() {
    // 1. Tell the server to stop.
    sendJSON({ type: 'stop' });

    // 2. Stop mic capture (also destroys the VAD if active).
    stopMicrophone();

    // 3. Cancel any playing / queued TTS audio.
    cancelTTS();

    // 4. Reset UI.
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus('idle');

    // 5. Close the WebSocket.
    if (ws) {
      ws.removeEventListener('close', handleWebSocketClose);
      ws.removeEventListener('message', handleServerMessage);
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
      ws = null;
    }
  }

  /**
   * Reset the UI to its idle state (used on error / disconnect).
   */
  function resetUI() {
    isRunning = false;
    stopMicrophone();
    cancelTTS();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus('idle');
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  startBtn.addEventListener('click', startConversation);
  stopBtn.addEventListener('click', stopConversation);

  // Initialize the status indicator and load the patient picker.
  updateStatus('idle');
  loadPatients();
})();
