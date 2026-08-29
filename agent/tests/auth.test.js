'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { apiKeyAuth, authenticateWebSocket } = require('../src/core/middleware/auth');

// Helper: create an Express app with a test route and dispatch a request
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/test', apiKeyAuth, (req, res) => res.json({ ok: true }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}

function mockReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    path: '/api/test',
    method: 'GET',
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

describe('apiKeyAuth middleware', () => {
  const originalApiKey = process.env.API_KEY;

  afterEach(() => {
    // Clean up env
    if (originalApiKey) {
      process.env.API_KEY = originalApiKey;
    } else {
      delete process.env.API_KEY;
    }
  });

  it('allows requests when API_KEY env is not set (dev mode)', () => {
    delete process.env.API_KEY;

    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;

    apiKeyAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('allows requests with valid API key in header', () => {
    process.env.API_KEY = 'secret123';

    const req = mockReq({ headers: { 'x-api-key': 'secret123' } });
    const res = mockRes();
    let nextCalled = false;

    apiKeyAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('allows requests with valid API key in query param', () => {
    process.env.API_KEY = 'secret123';

    const req = mockReq({ query: { api_key: 'secret123' } });
    const res = mockRes();
    let nextCalled = false;

    apiKeyAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('rejects requests with missing API key', () => {
    process.env.API_KEY = 'secret123';

    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;

    apiKeyAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.ok(res.body.error.includes('API key required'));
  });

  it('rejects requests with wrong API key', () => {
    process.env.API_KEY = 'secret123';

    const req = mockReq({ headers: { 'x-api-key': 'wrong' } });
    const res = mockRes();
    let nextCalled = false;

    apiKeyAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.error.includes('Invalid API key'));
  });

  it('header takes priority over query param', () => {
    process.env.API_KEY = 'secret123';

    const req = mockReq({
      headers: { 'x-api-key': 'secret123' },
      query: { api_key: 'wrong' },
    });
    const res = mockRes();
    let nextCalled = false;

    apiKeyAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
  });
});

describe('authenticateWebSocket', () => {
  const originalApiKey = process.env.API_KEY;

  afterEach(() => {
    if (originalApiKey) {
      process.env.API_KEY = originalApiKey;
    } else {
      delete process.env.API_KEY;
    }
  });

  it('allows all when API_KEY env is not set (dev mode)', () => {
    delete process.env.API_KEY;
    const req = { url: '/playground' };
    assert.equal(authenticateWebSocket(req), true);
  });

  it('allows with valid api_key query param', () => {
    process.env.API_KEY = 'ws-secret';
    const req = { url: '/playground?api_key=ws-secret' };
    assert.equal(authenticateWebSocket(req), true);
  });

  it('rejects with missing api_key', () => {
    process.env.API_KEY = 'ws-secret';
    const req = { url: '/playground' };
    assert.equal(authenticateWebSocket(req), false);
  });

  it('rejects with wrong api_key', () => {
    process.env.API_KEY = 'ws-secret';
    const req = { url: '/playground?api_key=wrong' };
    assert.equal(authenticateWebSocket(req), false);
  });
});
