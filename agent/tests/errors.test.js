'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { asyncRoute, errorMiddleware, installProcessHandlers, isAlways200 } = require('../src/core/errors');

/**
 * These assert the two properties the policy actually rests on:
 *
 *  1. an async route that throws reaches the error handler (Express 4 does not
 *     forward rejections on its own, so without the wrapper the request hangs
 *     and, on the phone path, the caller hears nothing)
 *  2. the handlers make failures MORE visible, never less — the process ones
 *     still exit, and the HTTP one never returns internals to a public client
 */

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
    },
  };
}

describe('asyncRoute', () => {
  test('forwards a rejected async handler to next() — Express 4 will not', async () => {
    const boom = new Error('kaboom');
    let forwarded = null;
    const wrapped = asyncRoute(async () => {
      throw boom;
    });

    wrapped({}, fakeRes(), (e) => {
      forwarded = e;
    });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(forwarded, boom);
  });

  test('does not call next() when the handler resolves', async () => {
    let called = false;
    const wrapped = asyncRoute(async (req, res) => {
      res.status(200).json({ ok: true });
    });
    const res = fakeRes();

    wrapped({}, res, () => {
      called = true;
    });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(called, false);
    assert.deepStrictEqual(res.body, { ok: true });
  });
});

describe('errorMiddleware', () => {
  test('never returns the error message or stack to the client', () => {
    const res = fakeRes();
    const err = new Error('SQLITE_ERROR: no such column: patients.secret_notes');
    err.stack = 'Error: ...\n  at /Users/someone/Developer/sahay/agent/src/db.js:1:1';

    errorMiddleware(err, { path: '/api/calls', originalUrl: '/api/calls', method: 'GET' }, res, () => {});

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { ok: false, error: 'Internal error' });
    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes('SQLITE'));
    assert.ok(!serialised.includes('Developer/sahay'));
  });

  test('answers /webhook with 200 — a non-2xx there makes the caller hear silence', () => {
    const res = fakeRes();
    errorMiddleware(new Error('boom'), { path: '/webhook', originalUrl: '/webhook', method: 'POST' }, res, () => {});

    assert.strictEqual(res.statusCode, 200);
    // Failure still travels, just as data rather than as transport.
    assert.deepStrictEqual(res.body, { ok: false, error: 'Internal error' });
  });

  test('ends the response instead of setting a status once streaming has begun', () => {
    const res = fakeRes();
    res.headersSent = true;

    errorMiddleware(new Error('mid-stream'), { path: '/api/calls', originalUrl: '/api/calls', method: 'GET' }, res, () => {});

    assert.strictEqual(res.ended, true);
    assert.strictEqual(res.statusCode, null);
  });

  test('isAlways200 covers the webhook path and its children, nothing else', () => {
    assert.ok(isAlways200('/webhook'));
    assert.ok(isAlways200('/webhook/vapi'));
    assert.ok(!isAlways200('/api/calls'));
    assert.ok(!isAlways200('/webhookish'));
  });
});

describe('installProcessHandlers', () => {
  test('exits on an unhandled rejection rather than serving from an unknown state', () => {
    const proc = new EventEmitter();
    const exits = [];
    installProcessHandlers({ proc, exit: (code) => exits.push(code) });

    proc.emit('unhandledRejection', new Error('nothing awaited this'));

    assert.deepStrictEqual(exits, [1]);
  });

  test('exits on an uncaught exception', () => {
    const proc = new EventEmitter();
    const exits = [];
    installProcessHandlers({ proc, exit: (code) => exits.push(code) });

    proc.emit('uncaughtException', new Error('boom'));

    assert.deepStrictEqual(exits, [1]);
  });

  test('handles a non-Error rejection reason without throwing inside the handler', () => {
    const proc = new EventEmitter();
    const exits = [];
    installProcessHandlers({ proc, exit: (code) => exits.push(code) });

    // `Promise.reject('a string')` is legal and would break naive reason.stack access.
    proc.emit('unhandledRejection', 'a string reason');

    assert.deepStrictEqual(exits, [1]);
  });
});
