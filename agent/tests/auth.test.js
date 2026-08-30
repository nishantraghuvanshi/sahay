'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  apiKeyAuth,
  authenticateWebSocket,
  vapiSecretAuth,
  authenticateVapiWebSocket,
  verifyVapiSecret,
  extractVapiSecret,
} = require('../src/core/middleware/auth');

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

describe('verifyVapiSecret', () => {
  it('accepts a matching secret', () => {
    assert.equal(verifyVapiSecret('shh', { VAPI_SECRET: 'shh' }), true);
  });

  it('rejects a wrong secret', () => {
    assert.equal(verifyVapiSecret('nope', { VAPI_SECRET: 'shh' }), false);
  });

  it('rejects a missing secret', () => {
    assert.equal(verifyVapiSecret(null, { VAPI_SECRET: 'shh' }), false);
    assert.equal(verifyVapiSecret(undefined, { VAPI_SECRET: 'shh' }), false);
  });

  // Fail-closed, not fail-open: this is what makes VAPI_SECRET's boot-time
  // requirement (safety-guard.js) actually load-bearing rather than
  // decorative — a caller that skips the guard still gets rejected here.
  it('rejects everyone when VAPI_SECRET itself is unset, never falls open', () => {
    assert.equal(verifyVapiSecret('anything', {}), false);
    assert.equal(verifyVapiSecret('', {}), false);
  });

  it('rejects secrets of different length without throwing', () => {
    assert.equal(verifyVapiSecret('short', { VAPI_SECRET: 'a much longer secret' }), false);
  });
});

describe('extractVapiSecret', () => {
  it('prefers the x-vapi-secret header over the api_key query param', () => {
    const req = { headers: { 'x-vapi-secret': 'from-header' }, query: { api_key: 'from-query' } };
    assert.equal(extractVapiSecret(req), 'from-header');
  });

  it('falls back to the api_key query param', () => {
    const req = { headers: {}, query: { api_key: 'from-query' } };
    assert.equal(extractVapiSecret(req), 'from-query');
  });

  it('returns null when neither is present', () => {
    assert.equal(extractVapiSecret({ headers: {}, query: {} }), null);
  });
});

describe('vapiSecretAuth middleware', () => {
  const original = process.env.VAPI_SECRET;

  afterEach(() => {
    if (original) process.env.VAPI_SECRET = original;
    else delete process.env.VAPI_SECRET;
  });

  it('rejects with 401 when no secret is configured', () => {
    delete process.env.VAPI_SECRET;
    const req = mockReq({ headers: {} });
    const res = mockRes();
    let nextCalled = false;
    vapiSecretAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('rejects with 401 on a wrong secret', () => {
    process.env.VAPI_SECRET = 'correct-secret';
    const req = mockReq({ headers: { 'x-vapi-secret': 'wrong' } });
    const res = mockRes();
    let nextCalled = false;
    vapiSecretAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('allows a matching header secret through', () => {
    process.env.VAPI_SECRET = 'correct-secret';
    const req = mockReq({ headers: { 'x-vapi-secret': 'correct-secret' } });
    const res = mockRes();
    let nextCalled = false;
    vapiSecretAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('allows a matching api_key query param through (WS-style callers)', () => {
    process.env.VAPI_SECRET = 'correct-secret';
    const req = mockReq({ headers: {}, query: { api_key: 'correct-secret' } });
    const res = mockRes();
    let nextCalled = false;
    vapiSecretAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

describe('authenticateVapiWebSocket', () => {
  const original = process.env.VAPI_SECRET;

  afterEach(() => {
    if (original) process.env.VAPI_SECRET = original;
    else delete process.env.VAPI_SECRET;
  });

  it('allows a matching api_key query param', () => {
    process.env.VAPI_SECRET = 'stt-secret';
    const req = { url: '/api/stt?api_key=stt-secret' };
    assert.equal(authenticateVapiWebSocket(req), true);
  });

  it('rejects a missing api_key', () => {
    process.env.VAPI_SECRET = 'stt-secret';
    const req = { url: '/api/stt' };
    assert.equal(authenticateVapiWebSocket(req), false);
  });

  it('rejects a wrong api_key', () => {
    process.env.VAPI_SECRET = 'stt-secret';
    const req = { url: '/api/stt?api_key=wrong' };
    assert.equal(authenticateVapiWebSocket(req), false);
  });

  it('rejects everyone when VAPI_SECRET is unset', () => {
    delete process.env.VAPI_SECRET;
    const req = { url: '/api/stt?api_key=anything' };
    assert.equal(authenticateVapiWebSocket(req), false);
  });
});
