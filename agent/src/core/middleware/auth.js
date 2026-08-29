'use strict';

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

  // If no API_KEY is configured, allow all (development mode)
  if (!serverKey) {
    return true;
  }

  // Parse the URL to extract query params
  const url = new URL(req.url, 'http://localhost');
  const providedKey = url.searchParams.get('api_key');

  if (!providedKey || providedKey !== serverKey) {
    logger.log('ws_auth_failed', { path: req.url });
    return false;
  }

  return true;
}

module.exports = { apiKeyAuth, authenticateWebSocket };
