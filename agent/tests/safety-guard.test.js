'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { assertSafeToServe, resolveBindHost, isInsecureLocalOn, OPT_OUT } = require('../src/core/safety-guard');

/**
 * The guard exists because an audit found API_KEY empty and
 * DISABLE_GUARDRAILS=true in the same working .env — auth off and the whole
 * safety block stripped, simultaneously, with nothing at boot saying so.
 *
 * Every case below passes an explicit env object rather than mutating
 * process.env, so these tests cannot leak into any other test file.
 */

// Minimal stand-ins for TransportPort implementations — assertSafeToServe
// only ever calls requiredSecrets() on what it's handed.
const vapiTransport = { requiredSecrets: () => [{ name: 'VAPI_SECRET', why: 'guards /webhook.' }] };
const elevenLabsTransport = {
  requiredSecrets: () => [
    { name: 'ELEVENLABS_WEBHOOK_SECRET', why: 'guards tool calls.' },
    { name: 'ELEVENLABS_POST_CALL_SECRET', why: 'guards the post-call webhook.' },
  ],
};
const playgroundTransport = { requiredSecrets: () => [] };

const SAFE = { API_KEY: 'shared-secret', ALERT_OPERATOR_CONTACT: '12345' };
const SAFE_VAPI = { ...SAFE, VAPI_SECRET: 'vapi-shared-secret' };
const SAFE_ELEVENLABS = {
  ...SAFE,
  ELEVENLABS_WEBHOOK_SECRET: 'el-webhook-secret',
  ELEVENLABS_POST_CALL_SECRET: 'el-post-call-secret',
};

describe('safety-guard', () => {
  test('accepts an API key with guardrails left on', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE_VAPI, vapiTransport));
    assert.doesNotThrow(() => assertSafeToServe({ ...SAFE_VAPI, DISABLE_GUARDRAILS: 'false' }, vapiTransport));
    assert.doesNotThrow(() => assertSafeToServe({ ...SAFE_VAPI, DISABLE_GUARDRAILS: '0' }, vapiTransport));
    assert.doesNotThrow(() => assertSafeToServe({ ...SAFE_VAPI, DISABLE_GUARDRAILS: '' }, vapiTransport));
  });

  test('refuses to start when API_KEY is unset — every PHI route would answer anyone', () => {
    assert.throws(() => assertSafeToServe({ VAPI_SECRET: 'x', ALERT_OPERATOR_CONTACT: 'x' }, vapiTransport), /API_KEY is not set/);
    assert.throws(
      () => assertSafeToServe({ API_KEY: '', VAPI_SECRET: 'x', ALERT_OPERATOR_CONTACT: 'x' }, vapiTransport),
      /API_KEY is not set/
    );
  });

  test('refuses to start when the active transport (vapi) is missing VAPI_SECRET', () => {
    assert.throws(() => assertSafeToServe(SAFE, vapiTransport), /VAPI_SECRET is not set/);
    assert.throws(() => assertSafeToServe({ ...SAFE, VAPI_SECRET: '' }, vapiTransport), /VAPI_SECRET is not set/);
  });

  test('boots with vapi active once VAPI_SECRET is present', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE_VAPI, vapiTransport));
  });

  test('vapi active does not require the elevenlabs secrets', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE_VAPI, vapiTransport));
    // The env doesn't even have them set, and the check still passes because
    // vapiTransport.requiredSecrets() never names them.
    assert.ok(!('ELEVENLABS_WEBHOOK_SECRET' in SAFE_VAPI));
  });

  test('refuses to start when the active transport (elevenlabs) is missing either secret', () => {
    assert.throws(() => assertSafeToServe(SAFE, elevenLabsTransport), /ELEVENLABS_WEBHOOK_SECRET is not set/);
    assert.throws(
      () => assertSafeToServe({ ...SAFE, ELEVENLABS_WEBHOOK_SECRET: 'x' }, elevenLabsTransport),
      /ELEVENLABS_POST_CALL_SECRET is not set/
    );
  });

  test('boots with elevenlabs active once both its secrets are present', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE_ELEVENLABS, elevenLabsTransport));
  });

  test('elevenlabs active does not require VAPI_SECRET', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE_ELEVENLABS, elevenLabsTransport));
    assert.ok(!('VAPI_SECRET' in SAFE_ELEVENLABS));
  });

  test('the playground transport requires no vendor secret', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE, playgroundTransport));
  });

  test('refuses to start when guardrails are disabled', () => {
    assert.throws(() => assertSafeToServe({ ...SAFE_VAPI, DISABLE_GUARDRAILS: 'true' }, vapiTransport), /DISABLE_GUARDRAILS/);
  });

  test('treats any non-false value as guardrails-off, wider than strategy.js does', () => {
    // strategy.js strips guardrails only on === 'true'. A value like '1' leaves
    // them in the prompt but still blocks boot. Over-refusing is recoverable;
    // serving an unguarded agent is not.
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      assert.throws(
        () => assertSafeToServe({ ...SAFE_VAPI, DISABLE_GUARDRAILS: value }, vapiTransport),
        /DISABLE_GUARDRAILS/,
        `expected ${value} to block boot`
      );
    }
  });

  test('refuses to start when ALERT_OPERATOR_CONTACT is unset — escalations would be logged to nobody', () => {
    assert.throws(
      () => assertSafeToServe({ API_KEY: 'x', VAPI_SECRET: 'x' }, vapiTransport),
      /ALERT_OPERATOR_CONTACT is not set/
    );
  });

  test('reports every unmet condition at once, not just the first', () => {
    assert.throws(
      () => assertSafeToServe({ DISABLE_GUARDRAILS: 'true' }, vapiTransport),
      (err) =>
        /API_KEY is not set/.test(err.message) &&
        /VAPI_SECRET is not set/.test(err.message) &&
        /ALERT_OPERATOR_CONTACT is not set/.test(err.message) &&
        /DISABLE_GUARDRAILS/.test(err.message)
    );
  });

  test('names the variable that fixes it, the way persistence-guard does', () => {
    assert.throws(() => assertSafeToServe({}, vapiTransport), new RegExp(OPT_OUT));
  });

  test('the single opt-out bypasses every check', () => {
    assert.doesNotThrow(() =>
      assertSafeToServe({ [OPT_OUT]: '1', DISABLE_GUARDRAILS: 'true' }, vapiTransport)
    );
  });

  test('a false-y opt-out does not bypass anything', () => {
    // Otherwise ALLOW_INSECURE_LOCAL=false would read as "opted out", which is
    // the opposite of what anyone writing that line intends.
    for (const value of ['false', '0', '']) {
      assert.throws(
        () => assertSafeToServe({ [OPT_OUT]: value }, vapiTransport),
        /API_KEY is not set/,
        `expected ${OPT_OUT}=${value} to leave the guard active`
      );
    }
  });

  test('throws a clear error when called without a transport', () => {
    assert.throws(() => assertSafeToServe(SAFE), /needs the resolved active transport/);
  });

  test('a missing transport still throws even when insecure mode is on', () => {
    // Ordering matters: the transport check is a programming-error guard, not
    // a security check, and must not be swallowed by ALLOW_INSECURE_LOCAL.
    assert.throws(
      () => assertSafeToServe({ [OPT_OUT]: '1' }),
      /needs the resolved active transport/
    );
  });
});

describe('safety-guard — isInsecureLocalOn', () => {
  test('mirrors the opt-out semantics assertSafeToServe uses', () => {
    assert.strictEqual(isInsecureLocalOn({ [OPT_OUT]: '1' }), true);
    assert.strictEqual(isInsecureLocalOn({ [OPT_OUT]: 'false' }), false);
    assert.strictEqual(isInsecureLocalOn({}), false);
  });
});

describe('safety-guard — resolveBindHost', () => {
  test('secure mode: HOST passes through unchanged, including unset', () => {
    assert.strictEqual(resolveBindHost({}), undefined);
    assert.strictEqual(resolveBindHost({ HOST: '0.0.0.0' }), '0.0.0.0');
    assert.strictEqual(resolveBindHost({ HOST: '127.0.0.1' }), '127.0.0.1');
  });

  test('insecure mode with HOST unset defaults to loopback, not "all interfaces"', () => {
    assert.strictEqual(resolveBindHost({ [OPT_OUT]: '1' }), '127.0.0.1');
  });

  test('insecure mode with HOST explicitly loopback passes through', () => {
    assert.strictEqual(resolveBindHost({ [OPT_OUT]: '1', HOST: '127.0.0.1' }), '127.0.0.1');
    assert.strictEqual(resolveBindHost({ [OPT_OUT]: '1', HOST: 'localhost' }), 'localhost');
    assert.strictEqual(resolveBindHost({ [OPT_OUT]: '1', HOST: '::1' }), '::1');
  });

  test('insecure mode with an explicit non-loopback HOST refuses to start', () => {
    assert.throws(
      () => resolveBindHost({ [OPT_OUT]: '1', HOST: '0.0.0.0' }),
      /HOST=0\.0\.0\.0 is not loopback/
    );
    assert.throws(
      () => resolveBindHost({ [OPT_OUT]: '1', HOST: '10.0.0.5' }),
      /is not loopback/
    );
  });

  test('a false-y opt-out leaves HOST=0.0.0.0 alone (secure mode is not this function\'s job)', () => {
    assert.strictEqual(resolveBindHost({ [OPT_OUT]: 'false', HOST: '0.0.0.0' }), '0.0.0.0');
  });
});
