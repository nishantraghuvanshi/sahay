'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { verifyElevenLabsSignature } = require('../src/adapters/transport/elevenlabs-signature');

// Scheme confirmed against ElevenLabs' post-call webhook docs and the
// hookdeck reference implementation, NOT invented here:
//   header  ElevenLabs-Signature: t=<unix secs>,v0=<hex>
//   signed  `${t}.${rawBody}`
//   hmac    SHA-256, the wsec_ secret used verbatim as the key, hex digest
//   replay  30-minute tolerance
//
// Four API contracts on this branch were guessed and wrong (see the design
// doc's "Implementation notes"). These tests build the signature the way the
// sender does rather than the way our verifier does, so they cannot silently
// pin our own guess: if the construction is wrong, sign() and the verifier are
// wrong together only if the error is in the shared constant, which is why the
// signed string is spelled out literally below.
const SECRET = 'wsec_test_0123456789abcdef';

function sign(rawBody, timestamp, secret = SECRET) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v0=${digest}`;
}

const NOW = 1_756_500_000;
const BODY = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'conv_1' } });

describe('ElevenLabs webhook signature verification', () => {
  test('accepts a signature the sender would actually produce', () => {
    const header = sign(BODY, NOW);
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: BODY, secret: SECRET, nowSecs: NOW }),
      true
    );
  });

  test('accepts a raw Buffer body, since that is what express hands us', () => {
    const header = sign(BODY, NOW);
    assert.strictEqual(
      verifyElevenLabsSignature({
        header,
        rawBody: Buffer.from(BODY, 'utf8'),
        secret: SECRET,
        nowSecs: NOW,
      }),
      true
    );
  });

  test('rejects a body that was altered after signing', () => {
    const header = sign(BODY, NOW);
    const tampered = JSON.stringify({
      type: 'post_call_transcription',
      data: { conversation_id: 'conv_ATTACKER' },
    });
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: tampered, secret: SECRET, nowSecs: NOW }),
      false
    );
  });

  test('rejects a signature made with a different secret', () => {
    const header = sign(BODY, NOW, 'wsec_wrong');
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: BODY, secret: SECRET, nowSecs: NOW }),
      false
    );
  });

  test('rejects a replayed delivery older than the 30-minute window', () => {
    const stale = NOW - 1801;
    const header = sign(BODY, stale);
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: BODY, secret: SECRET, nowSecs: NOW }),
      false
    );
  });

  test('accepts a delivery just inside the 30-minute window', () => {
    const recent = NOW - 1799;
    const header = sign(BODY, recent);
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: BODY, secret: SECRET, nowSecs: NOW }),
      true
    );
  });

  test('rejects a timestamp far in the future, not just far in the past', () => {
    // A clock-skew attack: without a forward bound, an attacker who captures
    // one signed body could hold it indefinitely if they could also influence
    // the timestamp forward.
    const header = sign(BODY, NOW + 1801);
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: BODY, secret: SECRET, nowSecs: NOW }),
      false
    );
  });

  test('fails closed when the secret is missing', () => {
    const header = sign(BODY, NOW);
    for (const secret of [undefined, null, '']) {
      assert.strictEqual(
        verifyElevenLabsSignature({ header, rawBody: BODY, secret, nowSecs: NOW }),
        false
      );
    }
  });

  test('fails closed on a missing, empty or malformed header', () => {
    for (const header of [undefined, null, '', 'garbage', 't=only', 'v0=only', 't=,v0=']) {
      assert.strictEqual(
        verifyElevenLabsSignature({ header, rawBody: BODY, secret: SECRET, nowSecs: NOW }),
        false,
        `expected rejection for header ${JSON.stringify(header)}`
      );
    }
  });

  test('fails closed when the raw body was never captured', () => {
    // If the express verify hook is not installed, req.rawBody is undefined.
    // Reconstructing it from the parsed JSON would change key order and
    // whitespace and silently break every signature, so the only safe
    // behaviour is to refuse.
    const header = sign(BODY, NOW);
    assert.strictEqual(
      verifyElevenLabsSignature({ header, rawBody: undefined, secret: SECRET, nowSecs: NOW }),
      false
    );
  });

  test('tolerates the v0 field appearing before t, and surrounding spaces', () => {
    const digest = crypto
      .createHmac('sha256', SECRET)
      .update(`${NOW}.${BODY}`)
      .digest('hex');
    assert.strictEqual(
      verifyElevenLabsSignature({
        header: ` v0=${digest} , t=${NOW} `,
        rawBody: BODY,
        secret: SECRET,
        nowSecs: NOW,
      }),
      true
    );
  });

  test('rejects a digest of the wrong length instead of throwing', () => {
    // crypto.timingSafeEqual throws on length mismatch; a webhook endpoint
    // that 500s on a malformed signature leaks that the comparison happened.
    assert.strictEqual(
      verifyElevenLabsSignature({
        header: `t=${NOW},v0=abc`,
        rawBody: BODY,
        secret: SECRET,
        nowSecs: NOW,
      }),
      false
    );
  });
});
