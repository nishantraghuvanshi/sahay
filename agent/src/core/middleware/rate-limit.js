'use strict';

const logger = require('../../utils/logger');

/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * /webhook and the /api/stt, /llm/chat/completions bridges are
 * unauthenticated-by-necessity entry points (Vapi calls them directly, so
 * they cannot sit behind apiKeyAuth) that each trigger a DB write or a paid
 * vendor call. That makes them a cost-amplification target even once
 * vapiSecretAuth (auth.js) closes the "anyone can call them" hole — a leaked
 * or brute-forced secret, or a Vapi-side retry storm, should not be able to
 * run the OpenAI/Sarvam bill up unboundedly.
 *
 * A fixed window (not sliding/token-bucket) is the right amount of
 * precision for this: it exists to cap a runaway loop, not to meter traffic
 * fairly to the millisecond. No new dependency — this project ships exactly
 * four (express, ws, js-yaml, dotenv) and a public webhook does not justify
 * a fifth.
 */

/**
 * @param {Object} opts
 * @param {number} opts.windowMs - Window length in milliseconds
 * @param {number} opts.max - Max requests/connections allowed per key per window
 * @param {string} opts.name - Label used in the rate_limit_exceeded log line
 * @returns {{allow: function(string): boolean, middleware: function}}
 */
function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map(); // key -> { count, windowStart }

  // Without this, `hits` grows by one entry per distinct key (IP) forever.
  // unref() so this timer never keeps the process alive on its own — tests
  // that spawn the server and then kill it should not need to wait it out.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs) hits.delete(key);
    }
  }, windowMs);
  if (cleanupTimer.unref) cleanupTimer.unref();

  /**
   * @param {string} key - Identity to count against, e.g. an IP address
   * @returns {boolean} true if this call is within the limit
   */
  function allow(key) {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return true;
    }

    entry.count += 1;
    if (entry.count > max) {
      logger.log('rate_limit_exceeded', { limiter: name, key, count: entry.count, max });
      return false;
    }
    return true;
  }

  /** Express middleware form, for routes that are allowed to answer non-200 on limit. */
  function middleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!allow(key)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  }

  return { allow, middleware };
}

module.exports = { createRateLimiter };
