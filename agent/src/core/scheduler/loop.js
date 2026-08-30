'use strict';

/**
 * spec: .superpowers/sdd/scheduler/task-4-brief.md
 *
 * The generic tick loop. It knows about time and overlap and nothing else —
 * no Vapi, no repository, no medication use case. The dose-specific tick it
 * drives is injected by the caller.
 *
 * Single-flight is load-bearing, not a nicety: `dose_events` has no "call in
 * flight" state. The unique index on (medication_id, slot_time) stops a
 * retried call from double-*logging*, but nothing stops double-*dialling* if
 * tick N is still awaiting a Vapi call when tick N+1's interval fires. This
 * loop's overlap guard, plus the next_attempt_at write the tick itself is
 * responsible for, are the only two things preventing that.
 *
 * Running two scheduler processes against one database is an explicit
 * non-goal: this guard is per-process. Two replicas would both see an
 * idle in-process flag, both dial the same patient, and nobody would find
 * out until a real person complained.
 */

const logger = require('../../utils/logger');

/**
 * @param {Object} deps
 * @param {() => Promise<any>} deps.tick - the work to run on each interval.
 * @param {number} deps.intervalMs - delay between ticks.
 * @param {() => Date} [deps.clock] - injected time source, for logging only.
 * @param {{ log: Function, error: Function }} [deps.logger] - defaults to the shared logger.
 * @returns {{ start: () => void, stop: () => void, runOnce: () => Promise<void> }}
 */
function createScheduler({ tick, intervalMs, clock = () => new Date(), logger: log = logger }) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) {
      log.log('scheduler_tick_skipped', { reason: 'overlap', now: clock().toISOString() });
      return;
    }
    running = true;
    try {
      await tick();
    } catch (err) {
      log.error('scheduler_tick_failed', err, { now: clock().toISOString() });
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      runOnce();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    log.log('scheduler_started', { intervalMs });
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    log.log('scheduler_stopped', {});
  }

  return { start, stop, runOnce };
}

module.exports = { createScheduler };
