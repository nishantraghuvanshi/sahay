'use strict';

const logger = require('../utils/logger');

/**
 * Error handling policy for this service.
 *
 * This codebase's characteristic bug is NOT an unhandled error. It is the
 * opposite: something that caught, logged healthily, and carried on doing
 * nothing — a webhook handler that did not exist behind a `{status:"ok"}`, an
 * UPDATE matching zero rows returning quietly, a sample-rate mismatch that
 * logged its own consequence and proceeded. Six shipped that way.
 *
 * So nothing here adds tolerance. Every helper below exists to make a failure
 * MORE visible, never less, and the policy is one sentence:
 *
 *   Fail loudly wherever silence would be dangerous; contain the failure only
 *   where an exception would make a live caller hear nothing — and there, say
 *   so in a distinct, greppable event.
 *
 * Two consequences worth stating, because they are what generic
 * error-handling boilerplate usually gets wrong:
 *
 *  1. The process-level handlers below deliberately still exit. Node crashes
 *     on an unhandled rejection by design; a handler that merely logs would
 *     convert a crash into a zombie process holding a phone call open. Their
 *     only job is to attach context on the way down.
 *
 *  2. The Express handler answers /webhook with HTTP 200 even on failure. A
 *     non-2xx there makes Vapi stall and the parent hears silence, so on that
 *     path failure must travel as data (`{ok:false}`) rather than as transport.
 *     Everywhere else a real status code is correct and more honest.
 */

/** Paths where a non-2xx would cost a live call. Failure travels as data here. */
const ALWAYS_200_PREFIXES = ['/webhook'];

function isAlways200(pathname) {
  return ALWAYS_200_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Wrap an async Express handler so a rejected promise reaches the error
 * middleware.
 *
 * Express 4 does not forward async rejections — an `await` that throws inside
 * `app.post('/x', async (req,res) => ...)` produces an unhandled rejection and
 * the request hangs until the client times out. On the phone path that is
 * indistinguishable from the agent going quiet. Express 5 fixes this natively;
 * until then every async route needs this wrapper.
 *
 * @param {Function} handler - async (req, res, next)
 * @returns {Function} Express-safe handler
 */
function asyncRoute(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Terminal Express error handler. Must be registered AFTER every route —
 * Express walks one ordered stack, and a handler registered early catches
 * nothing.
 *
 * Never returns a stack trace or an internal message to the client: this
 * service is public (Vapi must reach it) and its errors quote SQL, file paths
 * and occasionally patient data.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity; `next` must stay.
function errorMiddleware(err, req, res, next) {
  logger.error('unhandled_route_error', err);
  console.error(
    JSON.stringify({
      event: 'unhandled_route_error_detail',
      path: req.originalUrl,
      method: req.method,
      error: err && err.message,
      stack: err && err.stack,
      timestamp: new Date().toISOString(),
    })
  );

  if (res.headersSent) {
    // A stream (SSE, or a partially written TTS body) already started. There is
    // no status left to set; destroying is the only signal available.
    res.end();
    return;
  }

  const status = isAlways200(req.path) ? 200 : 500;
  res.status(status).json({ ok: false, error: 'Internal error' });
}

/**
 * Attach diagnostic context to a fatal error, then let the process die.
 *
 * Deliberately still exits. Suppressing these would be the exact failure mode
 * this file exists to argue against: a server that survives an unhandled
 * rejection is a server whose state nobody can reason about, still answering
 * calls about medication.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.exit] - injected for tests; defaults to process.exit
 * @param {Object} [opts.proc]   - injected for tests; defaults to process
 */
function installProcessHandlers({ exit, proc = process } = {}) {
  const die = exit || ((code) => proc.exit(code));

  proc.on('unhandledRejection', (reason) => {
    console.error(
      JSON.stringify({
        event: 'fatal_unhandled_rejection',
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : null,
        detail: 'A promise rejected with nothing awaiting it. Exiting rather than serving calls from an unknown state.',
        timestamp: new Date().toISOString(),
      })
    );
    die(1);
  });

  proc.on('uncaughtException', (err) => {
    console.error(
      JSON.stringify({
        event: 'fatal_uncaught_exception',
        error: err && err.message,
        stack: err && err.stack,
        detail: 'Exiting rather than serving calls from an unknown state.',
        timestamp: new Date().toISOString(),
      })
    );
    die(1);
  });
}

module.exports = { asyncRoute, errorMiddleware, installProcessHandlers, isAlways200 };
