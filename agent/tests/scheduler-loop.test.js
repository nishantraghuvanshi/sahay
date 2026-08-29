'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createScheduler } = require('../src/core/scheduler/loop');

/**
 * spec: .superpowers/sdd/scheduler/task-4-brief.md
 *
 * No test here sleeps or waits on a real interval. Overlap is driven by
 * calling runOnce() without awaiting it first (a deferred lets us control
 * exactly when the "in-flight" tick resolves). The timer itself is driven
 * by a hand-rolled fake for setInterval/clearInterval — no timer library
 * exists in this repo and none is added.
 */

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeLogger() {
  const logs = [];
  const errors = [];
  return {
    log: (event, data) => logs.push({ event, data }),
    error: (event, err, data) => errors.push({ event, err, data }),
    logs,
    errors,
  };
}

describe('createScheduler', () => {
  test('runOnce runs the tick', async () => {
    let calls = 0;
    const scheduler = createScheduler({
      tick: async () => {
        calls += 1;
      },
      intervalMs: 1000,
      logger: fakeLogger(),
    });

    await scheduler.runOnce();

    assert.strictEqual(calls, 1);
  });

  test('single-flight: a tick still running when runOnce fires again is skipped, not queued', async () => {
    let calls = 0;
    const first = deferred();
    const log = fakeLogger();
    const scheduler = createScheduler({
      tick: async () => {
        calls += 1;
        await first.promise;
      },
      intervalMs: 1000,
      logger: log,
    });

    const p1 = scheduler.runOnce(); // enters tick, awaits `first`
    // p1's tick body has started synchronously up to the first await by now.
    const p2 = scheduler.runOnce(); // must see running=true and skip immediately

    await p2; // the skip resolves without waiting on `first`
    assert.strictEqual(calls, 1, 'tick body must not have been re-entered');

    first.resolve();
    await p1;
    assert.strictEqual(calls, 1, 'still only the one call — nothing was queued');

    const skipLogs = log.logs.filter((l) => l.event === 'scheduler_tick_skipped');
    assert.strictEqual(skipLogs.length, 1);
    assert.strictEqual(skipLogs[0].data.reason, 'overlap');
  });

  test('a later runOnce runs normally once the in-flight tick has finished', async () => {
    let calls = 0;
    const scheduler = createScheduler({
      tick: async () => {
        calls += 1;
      },
      intervalMs: 1000,
      logger: fakeLogger(),
    });

    await scheduler.runOnce();
    await scheduler.runOnce();

    assert.strictEqual(calls, 2);
  });

  test('a throwing tick is caught, logged, and does not stop the loop', async () => {
    let calls = 0;
    const log = fakeLogger();
    const scheduler = createScheduler({
      tick: async () => {
        calls += 1;
        throw new Error('bad patient row');
      },
      intervalMs: 1000,
      logger: log,
    });

    await assert.doesNotReject(scheduler.runOnce());
    assert.strictEqual(calls, 1);
    assert.strictEqual(log.errors.length, 1);
    assert.strictEqual(log.errors[0].event, 'scheduler_tick_failed');
    assert.strictEqual(log.errors[0].err.message, 'bad patient row');

    // the loop survives: a subsequent tick still runs, not stuck "running".
    await scheduler.runOnce();
    assert.strictEqual(calls, 2);
  });

  test('a synchronously throwing tick is also caught and does not stop the loop', async () => {
    let calls = 0;
    const log = fakeLogger();
    const scheduler = createScheduler({
      tick: () => {
        calls += 1;
        throw new Error('sync boom');
      },
      intervalMs: 1000,
      logger: log,
    });

    await assert.doesNotReject(scheduler.runOnce());
    assert.strictEqual(log.errors.length, 1);

    await scheduler.runOnce();
    assert.strictEqual(calls, 2);
  });

  test('stop() is safe to call before start() and safe to call twice', () => {
    const scheduler = createScheduler({
      tick: async () => {},
      intervalMs: 1000,
      logger: fakeLogger(),
    });

    assert.doesNotThrow(() => scheduler.stop());
    assert.doesNotThrow(() => scheduler.stop());
  });

  test('start() schedules on the given interval, unrefs the timer, and stop() clears it', () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    let capturedCallback = null;
    let capturedMs = null;
    let unrefCalled = false;
    let cleared = null;
    const fakeTimer = { unref: () => { unrefCalled = true; } };

    global.setInterval = (cb, ms) => {
      capturedCallback = cb;
      capturedMs = ms;
      return fakeTimer;
    };
    global.clearInterval = (t) => {
      cleared = t;
    };

    try {
      let calls = 0;
      const log = fakeLogger();
      const scheduler = createScheduler({
        tick: async () => {
          calls += 1;
        },
        intervalMs: 5000,
        logger: log,
      });

      scheduler.start();

      assert.strictEqual(capturedMs, 5000);
      assert.strictEqual(unrefCalled, true, 'timer must be unref()\'d so it never holds the process open');
      assert.strictEqual(typeof capturedCallback, 'function');

      // starting twice must not schedule a second timer.
      scheduler.start();
      assert.strictEqual(cleared, null);

      // simulate the interval firing.
      capturedCallback();

      scheduler.stop();
      assert.strictEqual(cleared, fakeTimer);

      // stop() a second time must not throw and must not clear again with a stale timer.
      cleared = null;
      assert.doesNotThrow(() => scheduler.stop());
      assert.strictEqual(cleared, null);
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });

  test('runOnce uses the injected clock in its skip log, proving no reliance on real time', async () => {
    const first = deferred();
    const log = fakeLogger();
    const fixedNow = new Date('2026-08-30T09:00:00.000Z');
    const scheduler = createScheduler({
      tick: async () => {
        await first.promise;
      },
      intervalMs: 1000,
      clock: () => fixedNow,
      logger: log,
    });

    const p1 = scheduler.runOnce();
    await scheduler.runOnce();
    first.resolve();
    await p1;

    const skipLog = log.logs.find((l) => l.event === 'scheduler_tick_skipped');
    assert.strictEqual(skipLog.data.now, fixedNow.toISOString());
  });
});
