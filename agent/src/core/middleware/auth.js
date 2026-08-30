'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');

/**
 * API Key Authentication Middleware
 *
 * Validates a shared secret API key for HTTP routes and WebSocket connections.
 *
 * HTTP: checks the `x-api-key` header (or `?api_key=` query param).
 * WebSocket: checks the `api_key` query param on the upgrade URL.
 *
 * If `API_KEY` env var is not set, auth is disabled (development mode).
 * If set, all protected routes require a matching key.
 *
 * Public routes (no auth required):
 *   - GET /health
 *   - GET / (static files: index.html, playground UI)
 *   - GET /playground (the HTML page itself — the WS connection is authed separately)
 *
 * `vapiSecretAuth` / `authenticateVapiWebSocket` below are a separate check
 * against a separate secret (VAPI_SECRET, not API_KEY) — they guard the
 * routes Vapi itself calls (/webhook, /llm/chat/completions,
 * /api/tts/:provider, /api/stt), which by necessity accept no operator API
 * key at all. See src/core/safety-guard.js for why VAPI_SECRET is
 * unconditionally required at boot.
 */

/**
 * Express middleware for API key authentication on HTTP routes.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function apiKeyAuth(req, res, next) {
  const serverKey = process.env.API_KEY;

  // If no API_KEY is configured, skip auth (development mode)
  if (!serverKey) {
    return next();
  }

  // Check header first, then query param
  const providedKey = req.headers['x-api-key'] || req.query.api_key;

  if (!providedKey) {
    logger.log('auth_missing', { path: req.path, method: req.method });
    return res.status(401).json({ error: 'API key required. Provide x-api-key header or api_key query param.' });
  }

  if (providedKey !== serverKey) {
    logger.log('auth_invalid', { path: req.path, method: req.method });
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

/**
 * Non-rejecting check for the same API_KEY apiKeyAuth enforces — for a route
 * that must stay public (like GET /health) but can safely reveal more to a
 * caller who already holds the operator key. Never fails a request; it only
 * answers whether the caller proved they hold the key.
 *
 * If API_KEY itself is unset (dev mode), this always returns false — with no
 * key configured there is nothing a caller could prove, so /health stays at
 * its minimal, public shape rather than defaulting open.
 *
 * @param {Object} req
 * @returns {boolean}
 */
function hasValidApiKey(req) {
  const serverKey = process.env.API_KEY;
  if (!serverKey) return false;
  const providedKey = req.headers['x-api-key'] || req.query.api_key;
  return providedKey === serverKey;
}

/**
 * WebSocket authentication — called during the upgrade handshake.
 *
 * Checks for `api_key` query param in the WebSocket URL.
 * Returns true if the connection should be allowed, false otherwise.
 *
 * @param {Object} req - The HTTP upgrade request
 * @returns {boolean}
 */
function authenticateWebSocket(req) {
  const serverKey = process.env.API_KEY;

  // PLAYGROUND_KEY is a second, deliberately weaker credential for the
  // /playground socket, and only for it.
  //
  // The caregiver app's "meet the agent" step opens this socket straight from
  // the browser, so whatever it presents is public — anything VITE_-prefixed is
  // inlined into the bundle (NFR-7). Sending API_KEY there would publish the key
  // that guards POST /api/call, which places real phone calls, and GET /api/calls,
  // which returns call history. A visitor could dial arbitrary numbers.
  //
  // So the browser gets its own key and holds nothing else. Someone who lifts it
  // out of the bundle can talk to the demo agent and burn TTS credits; they
  // cannot place a call or read a record. API_KEY still works here, for the
  // operator tooling that already sends it.
  //
  // Unset means only API_KEY is accepted, so this cannot widen access by
  // accident on a deployment that never configures it.
  const playgroundKey = process.env.PLAYGROUND_KEY;

  // If no API_KEY is configured, allow all (development mode)
  if (!serverKey) {
    return true;
  }

  // Parse the URL to extract query params
  const url = new URL(req.url, 'http://localhost');
  const providedKey = url.searchParams.get('api_key');

  // PLAYGROUND_KEY unlocks the playground socket and nothing else. Scoped by
  // pathname rather than by trusting the caller, so presenting it against
  // /api/stt — the Vapi audio bridge — is still rejected.
  const isPlayground = url.pathname === '/playground';
  const accepted = isPlayground && playgroundKey
    ? [serverKey, playgroundKey]
    : [serverKey];

  if (!providedKey || !accepted.includes(providedKey)) {
    logger.log('ws_auth_failed', { path: req.url });
    return false;
  }

  return true;
}

/**
 * Constant-time string comparison. Buffer.equals / `===` short-circuit on
 * the first mismatched byte, which leaks length and prefix timing to an
 * attacker probing a webhook secret over the network. Comparison is
 * skipped entirely (not padded) when lengths differ — that length check
 * only leaks the length, never any byte of the actual secret.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Pull the Vapi shared secret out of an HTTP request. Vapi presents it as
 * the `x-vapi-secret` header on `server: { url, secret }` endpoints and on
 * custom-llm `model.headers`; the query param exists so the same check can
 * cover the /api/stt WebSocket upgrade, where a header is not guaranteed to
 * survive the handshake (see buildAssistantConfig in vapi.js).
 *
 * @param {Object} req
 * @returns {string|null}
 */
function extractVapiSecret(req) {
  return req.headers?.['x-vapi-secret'] || req.query?.api_key || null;
}

/**
 * Verify a provided secret against VAPI_SECRET.
 *
 * Deliberately unconditional: an unset VAPI_SECRET returns false rather than
 * "allow everyone", so a code path that forgets to boot through
 * assertSafeToServe (a test, a script) still fails closed instead of open.
 *
 * @param {string|null} providedSecret
 * @param {Object} [env]
 * @returns {boolean}
 */
function verifyVapiSecret(providedSecret, env = process.env) {
  const serverSecret = env.VAPI_SECRET;
  if (!serverSecret) return false;
  return timingSafeEqualStrings(providedSecret, serverSecret);
}

/**
 * Express middleware guarding the Vapi-only bridge endpoints
 * (/llm/chat/completions, /api/tts/:provider) that sit outside apiKeyAuth's
 * /api prefix and outside any operator's reach. A real 401 here is safe —
 * unlike /webhook, no caller is waiting on this response, so there is no
 * NFR-6 reason to answer 200.
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function vapiSecretAuth(req, res, next) {
  const provided = extractVapiSecret(req);
  if (!verifyVapiSecret(provided)) {
    logger.log('vapi_secret_rejected', { path: req.path, method: req.method });
    return res.status(401).json({ error: 'Invalid or missing Vapi secret.' });
  }
  next();
}

/**
 * WebSocket authentication for the /api/stt upgrade — the same secret as
 * vapiSecretAuth, carried as the `api_key` query param appended to the
 * transcriber's server.url in buildAssistantConfig (vapi.js).
 *
 * @param {Object} req - The HTTP upgrade request
 * @returns {boolean}
 */
function authenticateVapiWebSocket(req) {
  const url = new URL(req.url, 'http://localhost');
  const provided = url.searchParams.get('api_key');
  if (!verifyVapiSecret(provided)) {
    logger.log('vapi_ws_secret_rejected', { path: req.url });
    return false;
  }
  return true;
}

module.exports = {
  apiKeyAuth,
  authenticateWebSocket,
  hasValidApiKey,
  vapiSecretAuth,
  authenticateVapiWebSocket,
  verifyVapiSecret,
  extractVapiSecret,
};
