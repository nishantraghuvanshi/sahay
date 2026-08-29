'use strict';

/**
 * Turn latency instrumentation.
 *
 * PILOT-PLAN.md Q3 ("does it feel like a conversation?") targets P95 ≤ 2.5s
 * from the caller finishing speaking to the agent starting to speak. The
 * streaming pipeline already passes through every moment needed to measure
 * that, but recorded none of them — so the "~500ms to first audio" figure the
 * pipeline was built for had never actually been observed.
 *
 * Three moments per turn, all relative to the caller's speech ending:
 *   llmFirstTokenMs — STT result in, first LLM token out
 *   ttsFirstAudioMs — first audio chunk reaching the browser (what the user feels)
 *   turnTotalMs     — the whole turn
 *
 * Emitted as a structured log line so P50/P95 can be computed from logs
 * without any aggregation infrastructure.
 */
class TurnLatency {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.callId]
   * @param {number} [opts.turnIndex]
   * @param {Function} [opts.clock] - () => ms, injectable for tests
   * @param {Function} [opts.emit] - (metrics) => void
   */
  constructor(opts = {}) {
    this.callId = opts.callId || null;
    this.turnIndex = opts.turnIndex ?? null;
    this.clock = opts.clock || (() => Date.now());
    this.emit = opts.emit || defaultEmit;

    this.startedAt = this.clock();
    this.llmFirstTokenAt = null;
    this.ttsFirstAudioAt = null;
    this.completed = false;
  }

  /** First LLM token of this turn. Later calls are ignored. */
  llmFirstToken() {
    if (this.llmFirstTokenAt === null) this.llmFirstTokenAt = this.clock();
  }

  /** First audio chunk of this turn — the moment the caller hears something. */
  ttsFirstAudio() {
    if (this.ttsFirstAudioAt === null) this.ttsFirstAudioAt = this.clock();
  }

  /** Close the turn and emit. Idempotent. */
  turnComplete() {
    if (this.completed) return;
    this.completed = true;

    this.emit({
      callId: this.callId,
      turnIndex: this.turnIndex,
      llmFirstTokenMs: delta(this.startedAt, this.llmFirstTokenAt),
      ttsFirstAudioMs: delta(this.startedAt, this.ttsFirstAudioAt),
      turnTotalMs: this.clock() - this.startedAt,
    });
  }
}

/** @private */
function delta(from, to) {
  return to === null ? null : to - from;
}

/** @private */
function defaultEmit(metrics) {
  console.log(JSON.stringify({ event: 'turn_latency', ...metrics }));
}

module.exports = { TurnLatency };
