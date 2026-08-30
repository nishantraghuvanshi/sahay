/**
 * Browser voice session against the agent server's `/playground` WebSocket.
 *
 * This is the app-side client for the same endpoint the standalone page at
 * `agent/public/playground.js` talks to, and it speaks the protocol documented
 * in `agent/src/playground/ws-handler.js` verbatim:
 *
 *   browser → server   text: start / stop / barge-in / speech-detected /
 *                            silence-detected
 *                      binary: Int16 PCM, 16 kHz mono, only while speaking
 *   server → browser   status / mode / transcript / agent_response / audio /
 *                      outcome / error
 *
 * Which means a session started here runs the identical lifecycle a phone call
 * runs (`core/call/lifecycle.js`) — resolution, mode, per-turn capture, outcome.
 * The playground is not a mock of the agent; it is the agent without telephony.
 *
 * Framework-agnostic on purpose: React state lives in the screen, and this
 * class owns only the socket, the microphone and the playback queue. Every
 * exit path (stop, error, socket close, unmount) lands in `teardown()` so a
 * live microphone can never outlive the screen that opened it.
 */

import { Vad, downsample, floatTo16BitPcm, int16ToFloat32 } from './vad'

/** STT input rate the server expects. */
const TARGET_SAMPLE_RATE = 16000
/** Rate the TTS audio arrives at. */
const PLAYBACK_SAMPLE_RATE = 16000

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'
export type VoiceMode = 'outbound' | 'inbound' | 'resume'

export interface VoiceTurn {
  role: 'user' | 'agent'
  text: string
  /** True while this is a live, still-changing STT partial. */
  partial?: boolean
}

export interface VoiceOutcome {
  label: string
  reason?: string
}

export interface VoiceSessionHandlers {
  onState?: (state: VoiceState) => void
  onMode?: (mode: VoiceMode) => void
  /** A user partial (partial: true) or any final turn, in arrival order. */
  onTurn?: (turn: VoiceTurn) => void
  onOutcome?: (outcome: VoiceOutcome) => void
  onError?: (message: string) => void
  /** 0..1 mic energy, for the level meter. Fires only while speech is gated open. */
  onLevel?: (level: number) => void
  /** Fires once the session has fully stopped, however it stopped. */
  onClosed?: () => void
}

export interface VoiceSessionOptions extends VoiceSessionHandlers {
  /** Agent server origin, e.g. `http://localhost:3001`. Empty = same origin. */
  agentBase: string
  language: 'hi' | 'en'
  /** E.164 caller. An unknown number opens an intake conversation. */
  phone: string
  direction?: 'inbound' | 'outbound'
  /** The dose this simulated call is about. Sent verbatim in `start`. */
  drugName?: string
  mealRelation?: 'before' | 'after'
  meal?: 'breakfast' | 'lunch' | 'dinner'
  /** Sent as `?api_key=` when the server is running with API_KEY set. */
  apiKey?: string
}

export class VoiceSession {
  private opts: VoiceSessionOptions
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private vad: Vad | null = null

  private running = false
  private closed = false
  /**
   * True once `start` has gone out. The server greets a fresh socket with
   * `status: idle` before it is told to do anything, and that arrives while
   * the microphone permission prompt is still open — reporting it would put
   * "Not connected" on screen at the exact moment we are connecting.
   */
  private started = false

  private playbackQueue: AudioBuffer[] = []
  private playing = false
  private currentSource: AudioBufferSourceNode | null = null
  private agentSpeaking = false

  constructor(opts: VoiceSessionOptions) {
    this.opts = opts
  }

  /**
   * Connect, open the microphone, then ask the server to start talking.
   *
   * Order matters: the agent speaks first, so the mic has to be live before
   * `start` goes out or the caregiver's reply to the greeting is lost.
   */
  async start(): Promise<void> {
    if (this.running || this.closed) return
    this.running = true
    this.opts.onState?.('connecting')

    try {
      await this.connect()
      await this.openMicrophone()
      this.send({
        type: 'start',
        language: this.opts.language,
        phone: this.opts.phone,
        direction: this.opts.direction ?? 'inbound',
        drugName: this.opts.drugName ?? null,
        mealRelation: this.opts.mealRelation ?? null,
        meal: this.opts.meal ?? null,
      })
      this.started = true
    } catch (err) {
      // connect()/openMicrophone() have already reported something specific.
      if (!(err instanceof HandledError)) {
        this.opts.onError?.(err instanceof Error ? err.message : 'Could not start the conversation.')
      }
      this.teardown()
    }
  }

  /** Explicit hang-up. Idempotent, and safe to call from an unmount effect. */
  stop(): void {
    if (this.closed) return
    this.send({ type: 'stop' })
    this.teardown()
  }

  // ------------------------------------------------------------------- socket

  private wsUrl(): string {
    const base = this.opts.agentBase?.trim()
    let origin: URL
    if (base) {
      origin = new URL(base)
    } else {
      origin = new URL(window.location.origin)
    }
    origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL('/playground', origin)
    if (this.opts.apiKey) url.searchParams.set('api_key', this.opts.apiKey)
    return url.toString()
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(this.wsUrl())
      } catch {
        this.opts.onError?.('Could not reach the voice agent. Is the agent server running?')
        reject(new HandledError())
        return
      }
      socket.binaryType = 'arraybuffer'
      this.ws = socket

      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => {
        // `close` usually follows with detail; this covers the case where it does not.
        this.opts.onError?.('Could not reach the voice agent. Is the agent server running?')
        reject(new HandledError())
      })
      socket.addEventListener('message', (event) => this.handleMessage(event))
      socket.addEventListener('close', () => {
        // A close while running is the server or the network dropping us, not a hang-up.
        if (this.running && !this.closed) this.opts.onError?.('The connection to the agent dropped.')
        this.teardown()
      })
    })
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  private sendAudio(pcm: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm)
  }

  private handleMessage(event: MessageEvent): void {
    let message: Record<string, string>
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }

    switch (message.type) {
      case 'status': {
        const state = message.state as VoiceState
        this.agentSpeaking = state === 'speaking'
        // See `started`: the socket's own opening 'idle' is not a state the
        // caregiver is in, and teardown() owns the real return to idle.
        if (this.started) this.opts.onState?.(state)
        break
      }
      case 'mode':
        this.opts.onMode?.(message.mode as VoiceMode)
        break
      case 'transcript':
        // `isFinal` arrives as a real boolean; the cast above widened it.
        this.opts.onTurn?.({
          role: 'user',
          text: message.text,
          partial: !(message as unknown as { isFinal: boolean }).isFinal,
        })
        break
      case 'agent_response':
        this.opts.onTurn?.({ role: 'agent', text: message.text })
        break
      case 'audio':
        this.enqueueAudio(message.data)
        break
      case 'outcome':
        this.opts.onOutcome?.({ label: message.label, reason: message.reason })
        break
      case 'error':
        this.opts.onError?.(message.message)
        break
    }
  }

  // --------------------------------------------------------------- microphone

  private async openMicrophone(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch {
      this.opts.onError?.('Microphone access was blocked. Allow it in your browser, then try again.')
      throw new HandledError()
    }
    this.stream = stream

    const ctx = new AudioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    this.ctx = ctx
    this.source = ctx.createMediaStreamSource(stream)

    const vad = new Vad(ctx, this.source)
    this.vad = vad

    vad.onSpeechStart = () => {
      // Talking over the agent cuts it off — locally at once, so the caregiver
      // hears the interruption land, and server-side so it stops generating.
      if (this.agentSpeaking) {
        this.send({ type: 'barge-in' })
        this.cancelPlayback()
        this.opts.onState?.('listening')
      }
      this.send({ type: 'speech-detected' })
    }

    vad.onSpeechEnd = () => this.send({ type: 'silence-detected' })

    vad.onAudio = (pcm) => {
      if (!this.ctx) return
      const float32 = int16ToFloat32(pcm)
      this.opts.onLevel?.(peak(float32))
      const resampled = downsample(float32, this.ctx.sampleRate, TARGET_SAMPLE_RATE)
      this.sendAudio(floatTo16BitPcm(resampled))
    }

    await vad.start()
  }

  private closeMicrophone(): void {
    this.vad?.destroy()
    this.vad = null
    try { this.source?.disconnect() } catch { /* already gone */ }
    this.source = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  // ----------------------------------------------------------------- playback

  /** Decode one base64 PCM chunk and queue it behind whatever is playing. */
  private enqueueAudio(base64: string): void {
    if (!this.ctx) return
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const float32 = int16ToFloat32(bytes.buffer)
    const buffer = this.ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE)
    buffer.copyToChannel(float32, 0)

    this.playbackQueue.push(buffer)
    this.drain()
  }

  /** One chunk at a time — overlapping sources turn speech into noise. */
  private drain(): void {
    if (this.playing || this.playbackQueue.length === 0 || !this.ctx) return

    const buffer = this.playbackQueue.shift()
    if (!buffer) return

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    this.currentSource = source
    this.playing = true

    source.onended = () => {
      // A cancelled source has already been replaced; advancing here would
      // restart the queue cancelPlayback just emptied.
      if (this.currentSource !== source) return
      this.currentSource = null
      this.playing = false
      this.drain()
    }

    source.start()
  }

  private cancelPlayback(): void {
    if (this.currentSource) {
      const source = this.currentSource
      this.currentSource = null
      try { source.stop() } catch { /* already ended */ }
    }
    this.playbackQueue.length = 0
    this.playing = false
    this.agentSpeaking = false
  }

  // ----------------------------------------------------------------- teardown

  /** The single exit. Every failure path and the happy path both end here. */
  private teardown(): void {
    if (this.closed) return
    this.closed = true
    this.running = false

    this.closeMicrophone()
    this.cancelPlayback()

    const socket = this.ws
    this.ws = null
    if (socket) {
      try { socket.close() } catch { /* already closing */ }
    }

    void this.ctx?.close().catch(() => { /* already closed */ })
    this.ctx = null

    this.opts.onState?.('idle')
    this.opts.onClosed?.()
  }
}

/** Marks an error whose message has already been surfaced to the caller. */
class HandledError extends Error {}

/** Peak amplitude of a frame, for the level meter. */
function peak(samples: Float32Array): number {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i])
    if (value > max) max = value
  }
  return Math.min(1, max)
}
