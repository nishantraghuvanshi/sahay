'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { assertSafeToServe, OPT_OUT } = require('../src/core/safety-guard');

/**
 * The guard exists because an audit found API_KEY empty and
 * DISABLE_GUARDRAILS=true in the same working .env — auth off and the whole
 * safety block stripped, simultaneously, with nothing at boot saying so.
 *
 * Every case below passes an explicit env object rather than mutating
 * process.env, so these tests cannot leak into any other test file.
 */

const SAFE = { API_KEY: 'shared-secret', VAPI_SECRET: 'vapi-shared-secret' };

describe('safety-guard', () => {
  test('accepts an API key with guardrails left on', () => {
    assert.doesNotThrow(() => assertSafeToServe(SAFE));
    assert.doesNotThrow(() => assertSafeToServe({ ...SAFE, DISABLE_GUARDRAILS: 'false' }));
    assert.doesNotThrow(() => assertSafeToServe({ ...SAFE, DISABLE_GUARDRAILS: '0' }));
    assert.doesNotThrow(() => assertSafeToServe({ ...SAFE, DISABLE_GUARDRAILS: '' }));
  });

  test('refuses to start when API_KEY is unset — every PHI route would answer anyone', () => {
    assert.throws(() => assertSafeToServe({ VAPI_SECRET: 'x' }), /API_KEY is not set/);
    assert.throws(() => assertSafeToServe({ API_KEY: '', VAPI_SECRET: 'x' }), /API_KEY is not set/);
  });

  test('refuses to start when VAPI_SECRET is unset — /webhook and the bridges would answer anyone', () => {
    assert.throws(() => assertSafeToServe({ API_KEY: 'x' }), /VAPI_SECRET is not set/);
    assert.throws(() => assertSafeToServe({ API_KEY: 'x', VAPI_SECRET: '' }), /VAPI_SECRET is not set/);
  });

  test('refuses to start when guardrails are disabled', () => {
    assert.throws(() => assertSafeToServe({ ...SAFE, DISABLE_GUARDRAILS: 'true' }), /DISABLE_GUARDRAILS/);
  });

  test('treats any non-false value as guardrails-off, wider than strategy.js does', () => {
    // strategy.js strips guardrails only on === 'true'. A value like '1' leaves
    // them in the prompt but still blocks boot. Over-refusing is recoverable;
    // serving an unguarded agent is not.
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      assert.throws(
        () => assertSafeToServe({ ...SAFE, DISABLE_GUARDRAILS: value }),
        /DISABLE_GUARDRAILS/,
        `expected ${value} to block boot`
      );
    }
  });

  test('reports every unmet condition at once, not just the first', () => {
    assert.throws(
      () => assertSafeToServe({ DISABLE_GUARDRAILS: 'true' }),
      (err) => /API_KEY is not set/.test(err.message) && /DISABLE_GUARDRAILS/.test(err.message)
    );
  });

  test('names the variable that fixes it, the way persistence-guard does', () => {
    assert.throws(() => assertSafeToServe({}), new RegExp(OPT_OUT));
  });

  test('the single opt-out bypasses every check', () => {
    assert.doesNotThrow(() =>
      assertSafeToServe({ [OPT_OUT]: '1', DISABLE_GUARDRAILS: 'true' })
    );
  });

  test('a false-y opt-out does not bypass anything', () => {
    // Otherwise ALLOW_INSECURE_LOCAL=false would read as "opted out", which is
    // the opposite of what anyone writing that line intends.
    for (const value of ['false', '0', '']) {
      assert.throws(
        () => assertSafeToServe({ [OPT_OUT]: value }),
        /API_KEY is not set/,
        `expected ${OPT_OUT}=${value} to leave the guard active`
      );
    }
  });
});
