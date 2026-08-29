'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Raw webhook capture.
 *
 * Every payload shape this service parses was written against documentation and
 * hand-built test fixtures — no real Vapi request has ever been seen. Two of the
 * branch's largest risks come from that: whether `tool-call` really arrives as
 * `message.tool.{name,arguments}`, and what the real `endedReason` strings look
 * like (the codebase currently contains both `customer-ended-call` and
 * `customer_did_not_answer`, which cannot both be right).
 *
 * This middleware writes each raw body verbatim, before any parsing or
 * dispatch, so a single real phone call settles both questions permanently.
 *
 * Opt-in: does nothing unless CAPTURE_WEBHOOKS is set to a file path. Never
 * throws into the request path — a capture failure must not cost a live call.
 *
 * Contains caller phone numbers and transcript fragments, so the output file is
 * call data: keep it out of git (agent/data/ is already ignored).
 */
function createWebhookCapture(captureFile) {
  if (!captureFile) return (req, res, next) => next();

  try {
    fs.mkdirSync(path.dirname(captureFile), { recursive: true });
  } catch {
    // Directory creation failed; the append below will report it once.
  }

  return function captureWebhook(req, res, next) {
    try {
      fs.appendFileSync(
        captureFile,
        `${JSON.stringify({
          captured_at: new Date().toISOString(),
          method: req.method,
          url: req.originalUrl,
          headers: req.headers,
          body: req.body,
        })}\n`
      );
    } catch (err) {
      // Log once and carry on — capture is diagnostics, the call is the product.
      console.log(
        JSON.stringify({
          event: 'webhook_capture_failed',
          timestamp: new Date().toISOString(),
          error: err.message,
        })
      );
    }
    next();
  };
}

module.exports = { createWebhookCapture };
