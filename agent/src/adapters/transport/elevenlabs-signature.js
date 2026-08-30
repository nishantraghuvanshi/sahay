'use strict';

const crypto = require('crypto');

/**
 * ElevenLabs signs every webhook delivery. This verifies that signature.
 *
 * The scheme is theirs, not ours, and it is NOT the `X-Kinvox-Token` header we
 * attach to our own tool declarations — we control those requests, we do not
 * control this one:
 *
 *   header   ElevenLabs-Signature: t=<unix secs>,v0=<hex sha256>
 *   signed   `${timestamp}.${raw request body}`
 *   key      the wsec_… signing secret, used verbatim (no prefix stripping,
 *            no base64 decode)
 *   replay   30 minutes either side of now
 *
 * Confirmed against ElevenLabs' post-call webhook documentation and the
 * hookdeck reference implementation before it was written. Four other API
 * contracts on this branch were inferred and turned out wrong (see the design
 * doc's "Implementation notes"), so it is worth saying which of these facts is
 * load-bearing: if the signed-string construction is wrong, every real
 * delivery fails closed and is logged as unauthorized. It cannot fail open.
 *
 * The raw body matters. Re-serialising the parsed JSON would reorder keys and
 * drop whitespace, producing a different digest for a byte-identical request,
 * so callers must capture the untouched buffer (see the `verify` hook on
 * express.json in server.js) and pass it here.
 */
const TOLERANCE_SECS = 1800;

/**
 * @param {Object} params
 * @param {string} [params.header] - raw ElevenLabs-Signature header value
 * @param {Buffer|string} [params.rawBody] - the untouched request body
 * @param {string} [params.secret] - the wsec_ signing secret
 * @param {number} [params.nowSecs] - current unix time; injectable for tests
 * @param {number} [params.toleranceSecs]
 * @returns {boolean} true only if the signature is present, well-formed,
 *   fresh and correct. Every other outcome is false — never an exception,
 *   because a webhook route that 500s on a malformed signature tells an
 *   unauthenticated caller that its guess reached the comparison.
 */
function verifyElevenLabsSignature({
  header,
  rawBody,
  secret,
  nowSecs = Math.floor(Date.now() / 1000),
  toleranceSecs = TOLERANCE_SECS,
} = {}) {
  if (!secret || !header || rawBody === undefined || rawBody === null) return false;

  const parts = String(header).split(',');
  let timestamp = null;
  let provided = null;
  for (const part of parts) {
    const trimmed = part.trim();
    // Order is not guaranteed by any contract we control, so parse by key
    // rather than by position.
    if (trimmed.startsWith('t=')) timestamp = trimmed.slice(2).trim();
    else if (trimmed.startsWith('v0=')) provided = trimmed.slice(3).trim();
  }
  if (!timestamp || !provided) return false;

  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt)) return false;
  // Bounded on both sides: a delivery from the future is as suspect as a
  // replayed one, and only the past bound would be checked by accident.
  if (Math.abs(nowSecs - issuedAt) > toleranceSecs) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws rather than returning false when the lengths
  // differ, and a wrong-length digest is a normal thing for a hostile caller
  // to send.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * `verify` hook for express.json that keeps the untouched request body.
 *
 * express.json consumes the stream and leaves only the parsed object, so
 * without this the bytes that were signed are gone by the time any route runs.
 * It must be installed on the parser itself — a route-level middleware is too
 * late, because the global parser has already drained the request.
 *
 * Exported so server.js and the tests install the identical hook; a test that
 * captured the body differently from production would verify nothing.
 */
function captureRawBody(req, _res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}

module.exports = { verifyElevenLabsSignature, captureRawBody, TOLERANCE_SECS };
