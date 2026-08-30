/**
 * Energy-based voice activity detection for the in-browser playground.
 *
 * A TypeScript port of `agent/public/vad.js`, which drives the agent server's
 * own standalone playground page. The two are deliberately the same algorithm
 * with the same tuned constants — RMS per frame, a one-second adaptive
 * calibration against room noise, pre-speech padding so the first syllable is
 * never clipped, and a trailing-silence endpoint. If either side is retuned,
 * retune both: a barge-in that works on `/playground` and not in the app (or
 * the reverse) is the failure this note exists to prevent.
 *
 * Why an energy VAD and not a model: it costs nothing, adds no bundle weight,
 * and the endpoint decision is made server-side anyway (`silence-detected` is
 * a hint, not a command). This only has to be good enough to gate the mic and
 * notice that someone started talking over the agent.
 */

export interface VadOptions {
  /** RMS above which a frame counts as speech. Overwritten by calibration. */
  energyThreshold: number
  /** Milliseconds of pre-speech audio replayed when speech starts. */
  speechPadMs: number
  /** Trailing silence before an endpoint is declared. */
  silenceTimeoutMs: number
  /** Speech bursts shorter than this are noise, not a turn. */
  minSpeechDurationMs: number
  /** Calibrate the threshold from background noise on start(). */
  adaptiveThreshold: boolean
  /** Length of that calibration window. */
  calibrationMs: number
}

const DEFAULTS: VadOptions = {
  energyThreshold: 0.01,
  speechPadMs: 300,
  silenceTimeoutMs: 1500,
  minSpeechDurationMs: 200,
  adaptiveThreshold: true,
  calibrationMs: 1000,
}

/** ScriptProcessorNode buffer size (must be a power of two). */
const BUFFER_SIZE = 4096

type State = 'SILENCE' | 'SPEECH' | 'TRAILING_SILENCE'

export class Vad {
  onSpeechStart: (() => void) | null = null
  onSpeechEnd: (() => void) | null = null
  /** Int16 PCM at the AudioContext's own sample rate — resample before sending. */
  onAudio: ((pcm: ArrayBuffer) => void) | null = null

  private ctx: AudioContext | null
  private source: AudioNode | null
  private opts: VadOptions

  private state: State = 'SILENCE'
  private running = false
  private destroyed = false

  /** Rolling pre-speech buffer, flushed the moment speech is detected. */
  private padChunks: Float32Array[] = []
  private padMs = 0

  private silenceStartTs = 0
  private speechStartTs = 0
  private emittedSpeechStart = false

  private calibrating = false
  private calibrationStartTs = 0
  private calibrationSum = 0
  private calibrationFrames = 0

  private processor: ScriptProcessorNode | null = null
  private muteGain: GainNode | null = null

  constructor(ctx: AudioContext, source: AudioNode, opts: Partial<VadOptions> = {}) {
    this.ctx = ctx
    this.source = source
    this.opts = { ...DEFAULTS, ...opts }
  }

  async start(): Promise<void> {
    if (this.destroyed) throw new Error('VAD: cannot start a destroyed instance')
    if (this.running) return
    const ctx = this.ctx
    const source = this.source
    if (!ctx || !source) return

    // Autoplay policy: the context is suspended until a user gesture. The
    // caller's click is that gesture, so resuming here is always allowed.
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.destroyed) return

    this.reset()

    // ScriptProcessorNode is deprecated but universally supported and the
    // shortest path to raw PCM frames. An AudioWorklet would need a separate
    // module file served at a stable URL for one small win.
    const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1)
    processor.onaudioprocess = (event) => this.handleFrame(event)

    // Route through zero gain: the node only fires while connected to a
    // destination, and connecting it directly would put the mic on the
    // speakers and feed every word back into the agent.
    const muteGain = ctx.createGain()
    muteGain.gain.value = 0

    source.connect(processor)
    processor.connect(muteGain)
    muteGain.connect(ctx.destination)

    this.processor = processor
    this.muteGain = muteGain
    this.running = true

    if (this.opts.adaptiveThreshold) {
      this.calibrating = true
      this.calibrationStartTs = performance.now()
      this.calibrationSum = 0
      this.calibrationFrames = 0
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.teardown()
    this.reset()
  }

  destroy(): void {
    if (this.destroyed) return
    this.stop()
    this.destroyed = true
    this.ctx = null
    this.source = null
    this.onSpeechStart = null
    this.onSpeechEnd = null
    this.onAudio = null
  }

  // ---------------------------------------------------------------- internals

  private teardown(): void {
    if (this.processor) {
      try { this.source?.disconnect(this.processor) } catch { /* already gone */ }
      try { this.processor.disconnect() } catch { /* already gone */ }
      this.processor.onaudioprocess = null
      this.processor = null
    }
    if (this.muteGain) {
      try { this.muteGain.disconnect() } catch { /* already gone */ }
      this.muteGain = null
    }
  }

  private reset(): void {
    this.state = 'SILENCE'
    this.padChunks = []
    this.padMs = 0
    this.silenceStartTs = 0
    this.speechStartTs = 0
    this.emittedSpeechStart = false
    this.calibrating = false
    this.calibrationStartTs = 0
    this.calibrationSum = 0
    this.calibrationFrames = 0
  }

  private handleFrame(event: AudioProcessingEvent): void {
    if (!this.running || this.destroyed || !this.ctx) return

    const channel = event.inputBuffer.getChannelData(0)
    // Copy: the browser reuses the underlying buffer after this callback, and
    // padding holds frames for up to speechPadMs.
    const samples = new Float32Array(channel.length)
    samples.set(channel)

    const rms = computeRms(samples)
    const frameMs = (samples.length / this.ctx.sampleRate) * 1000

    if (this.calibrating) {
      this.calibrate(rms)
      // Keep filling padding, but suppress detection — otherwise the room's
      // own hum starts a turn before the threshold is known.
      this.pushPadding(samples, frameMs)
      return
    }

    this.drive(rms, samples, frameMs)
  }

  /** Threshold becomes max(0.01, background × 3) once the window closes. */
  private calibrate(rms: number): void {
    this.calibrationSum += rms
    this.calibrationFrames += 1
    if (performance.now() - this.calibrationStartTs < this.opts.calibrationMs) return

    const avgNoise = this.calibrationFrames > 0 ? this.calibrationSum / this.calibrationFrames : 0
    this.opts.energyThreshold = Math.max(0.01, avgNoise * 3)
    this.calibrating = false
  }

  private drive(rms: number, samples: Float32Array, frameMs: number): void {
    const isSpeech = rms > this.opts.energyThreshold
    const ts = performance.now()

    switch (this.state) {
      case 'SILENCE':
        this.pushPadding(samples, frameMs)
        if (isSpeech) {
          this.state = 'SPEECH'
          this.speechStartTs = ts
          this.emittedSpeechStart = false
          // Padding first, so the recipient hears the lead-in before this frame.
          this.flushPadding()
          this.emit(samples)
          this.maybeFireSpeechStart(ts)
        }
        break

      case 'SPEECH':
        this.emit(samples)
        if (isSpeech) {
          this.maybeFireSpeechStart(ts)
        } else {
          this.state = 'TRAILING_SILENCE'
          this.silenceStartTs = ts
        }
        break

      case 'TRAILING_SILENCE':
        this.emit(samples)
        if (isSpeech) {
          this.state = 'SPEECH'
          this.silenceStartTs = 0
          this.maybeFireSpeechStart(ts)
        } else if (ts - this.silenceStartTs >= this.opts.silenceTimeoutMs) {
          this.fireSpeechEnd()
          this.state = 'SILENCE'
          this.emittedSpeechStart = false
          this.speechStartTs = 0
          this.silenceStartTs = 0
          this.pushPadding(samples, frameMs)
        }
        break
    }
  }

  private pushPadding(samples: Float32Array, frameMs: number): void {
    this.padChunks.push(samples)
    this.padMs += frameMs
    while (this.padMs > this.opts.speechPadMs && this.padChunks.length > 1) {
      const oldest = this.padChunks.shift()
      if (oldest && this.ctx) this.padMs -= (oldest.length / this.ctx.sampleRate) * 1000
    }
  }

  private flushPadding(): void {
    for (const chunk of this.padChunks) this.emit(chunk)
    this.padChunks = []
    this.padMs = 0
  }

  private emit(samples: Float32Array): void {
    this.onAudio?.(floatTo16BitPcm(samples))
  }

  /** Held back by minSpeechDurationMs so a cough is not a barge-in. */
  private maybeFireSpeechStart(ts: number): void {
    if (this.emittedSpeechStart) return
    if (ts - this.speechStartTs < this.opts.minSpeechDurationMs) return
    this.emittedSpeechStart = true
    this.onSpeechStart?.()
  }

  /** Never fires for a burst that never counted as speech in the first place. */
  private fireSpeechEnd(): void {
    if (!this.emittedSpeechStart) return
    this.onSpeechEnd?.()
  }
}

// -------------------------------------------------------------- PCM utilities

export function computeRms(buffer: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}

/** Float samples in [-1, 1] to little-endian Int16 PCM. */
export function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
}

export function int16ToFloat32(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  const int16 = new Int16Array(buffer)
  // Explicitly backed by an ArrayBuffer, never a SharedArrayBuffer: the result is
  // handed straight to AudioBuffer.copyToChannel, which accepts only the former.
  const float32 = new Float32Array(new ArrayBuffer(int16.length * 4))
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768
  return float32
}

/** Linear-interpolation downsample. Upsampling is never needed here. */
export function downsample(buffer: Float32Array, from: number, to: number): Float32Array {
  if (to === from) return buffer
  if (to > from) throw new Error('VAD: upsampling is not supported')

  const ratio = from / to
  const out = new Float32Array(Math.round(buffer.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, buffer.length - 1)
    const fraction = position - left
    out[i] = buffer[left] * (1 - fraction) + buffer[right] * fraction
  }
  return out
}
