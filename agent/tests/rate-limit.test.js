'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createRateLimiter } = require('../src/core/middleware/rate-limit');

function mockReqRes(ip = '1.2.3.4') {
  const req = { ip };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return { req, res };
}

describe('createRateLimiter', () => {
  test('allows requests under the limit', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 3, name: 'test' });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), true);
  });

  test('rejects once a key exceeds the limit within the window', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 2, name: 'test' });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
  });

  test('tracks separate keys independently', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test' });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('b'), true);
    assert.equal(limiter.allow('a'), false);
    assert.equal(limiter.allow('b'), false);
  });

  test('resets after the window elapses', async () => {
    const limiter = createRateLimiter({ windowMs: 20, max: 1, name: 'test' });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(limiter.allow('a'), true);
  });

  test('middleware calls next() when under the limit', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 5, name: 'test' });
    const { req, res } = mockReqRes();
    let nextCalled = false;
    limiter.middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test('middleware responds 429 when over the limit', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test' });
    const { req, res } = mockReqRes();
    limiter.middleware(req, res, () => {});
    let nextCalled = false;
    limiter.middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
  });

  test('middleware keys by req.ip, so different IPs get independent budgets', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, name: 'test' });
    const first = mockReqRes('1.1.1.1');
    const second = mockReqRes('2.2.2.2');
    let firstNext = false;
    let secondNext = false;
    limiter.middleware(first.req, first.res, () => { firstNext = true; });
    limiter.middleware(second.req, second.res, () => { secondNext = true; });
    assert.equal(firstNext, true);
    assert.equal(secondNext, true);
  });
});
