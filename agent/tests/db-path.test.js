'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  redactCredentials,
  assertFilesystemPath,
  resolveConfiguredDbPath,
  NotAFilesystemPathError,
} = require('../src/utils/db-path');

/**
 * spec: .superpowers/sdd/modularise-boundaries/task-4-brief.md, controller
 * addendum. Fifth requirement: reject a DB_PATH/DATABASE_URL/VOXIKIN_DB that
 * is not a filesystem path (agent/postgresql:/... in this working tree is
 * real evidence of what happens without this), fail closed before anything
 * is created, and never let a legitimate path — including one with ':' or
 * '@' in it — get caught.
 *
 * The table of inputs lives in api/fixtures/db-path-cases.json, NOT here,
 * and api/tests/test_db_path.py reads the same file. That fixture is the
 * only thing keeping agent/src/utils/db-path.js and api/db_path.py in step.
 * They were previously "kept in step by the tests on each side" and drifted
 * anyway — Node keying redaction on "://" and Python on ":/" — so Node
 * printed `postgresql:/user:PASSWORD@host/db` verbatim while Python mangled
 * `C:/Users/x/data.db`. Neither suite ever ran the other's inputs, and four
 * review rounds passed over it. Add a case to the fixture, never to one side.
 */

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'fixtures', 'db-path-cases.json'), 'utf8')
);

describe('the shared cross-runtime fixture (api/fixtures/db-path-cases.json)', () => {
  test('is present and non-trivial — an empty fixture must not read as a pass', () => {
    assert.ok(Array.isArray(FIXTURE.cases), 'fixture has no cases[]');
    assert.ok(FIXTURE.cases.length >= 30, `expected 30+ shared cases, got ${FIXTURE.cases.length}`);
    assert.ok(FIXTURE.cases.some((c) => c.connection_string), 'no connection-string cases');
    assert.ok(FIXTURE.cases.some((c) => !c.connection_string), 'no passthrough cases');
    assert.ok(Array.isArray(FIXTURE.redos) && FIXTURE.redos.length > 0, 'fixture has no redos[]');
  });

  test('every case the fixture calls a connection string carries the four shapes finding 1 named', () => {
    const inputs = new Set(FIXTURE.cases.map((c) => c.input));
    for (const required of [
      'postgresql://kinvox:SECRETPW@localhost:5432/kinvox',
      'postgresql:/kinvox:SECRETPW@localhost:5432/kinvox',
      ':/user:SECRET@host',
      '://user:SECRET@host',
      '1abc:/user:SECRET@host',
      '$$$://user:SECRET@host',
      'C:/Users/x/data.db',
    ]) {
      assert.ok(inputs.has(required), `fixture is missing the required case ${JSON.stringify(required)}`);
    }
  });
});

describe('redactCredentials — every case in the shared fixture', () => {
  for (const c of FIXTURE.cases) {
    test(`${c.connection_string ? 'coarsens' : 'passes through byte-identical'}: ${c.label}`, () => {
      const got = redactCredentials(c.input);
      assert.strictEqual(got, c.expected);
      if (!c.connection_string) {
        // Not merely "equal": the same string, so a real path can never be
        // corrupted into pointing at a different database.
        assert.strictEqual(got, c.input);
        return;
      }
      for (const forbidden of c.forbidden || []) {
        assert.ok(!got.includes(forbidden), `${JSON.stringify(forbidden)} survived into ${got}`);
      }
      // The structural guarantee, checked by construction rather than by
      // pattern: userinfo cannot exist in the output at all.
      assert.ok(!got.includes('@'), `an authority delimiter survived into ${got}`);
    });
  }
});

describe('assertFilesystemPath — the same fixture, the same predicate', () => {
  for (const c of FIXTURE.cases) {
    test(`${c.connection_string ? 'rejects' : 'accepts'}: ${c.label}`, () => {
      if (!c.connection_string) {
        assert.doesNotThrow(() => assertFilesystemPath(c.input, 'DB_PATH'));
        return;
      }
      let error = null;
      try {
        assertFilesystemPath(c.input, 'DB_PATH');
      } catch (e) {
        error = e;
      }
      assert.ok(error instanceof NotAFilesystemPathError, 'expected NotAFilesystemPathError');
      // Finding 1's self-inflicted half: the guard rejected on ":/+" but
      // rendered the offending value through a redactor that only understood
      // "://", so the password it exists to protect was printed in clear.
      // The message must carry the SAME redaction the fixture pins.
      assert.ok(
        error.message.includes(c.expected),
        `message does not render the value through redactCredentials: ${error.message}`
      );
      for (const forbidden of c.forbidden || []) {
        assert.ok(!error.message.includes(forbidden), `leaked into the message: ${error.message}`);
      }
      assert.ok(!error.message.includes('@'), `an authority delimiter survived: ${error.message}`);
    });
  }
});

describe('assertFilesystemPath — message shape (wording is per-runtime, not shared)', () => {
  test('the error names the variable that was set', () => {
    assert.throws(
      () => assertFilesystemPath('postgresql://a:b@c/d', 'DATABASE_URL'),
      /DATABASE_URL/
    );
  });

  test('falls back to a generic label when no variable name is given', () => {
    assert.throws(() => assertFilesystemPath('postgresql://a:b@c/d'), /configured database path/);
  });
});

describe('redactCredentials — inputs whose coercion is language-specific, so not shareable', () => {
  // String(null) is 'null' but str(None) is 'None'; String(undefined) has no
  // Python counterpart at all. These cannot live in the shared fixture, so
  // each side asserts "never throws" locally.
  const EDGE_INPUTS = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
  ];
  for (const [label, input] of EDGE_INPUTS) {
    test(label, () => {
      assert.doesNotThrow(() => redactCredentials(input));
    });
  }
});

describe('no ReDoS — the budgets in the shared fixture', () => {
  // Best of five: the budgets are tight enough that a single unlucky GC or
  // scheduler slice would dominate, and the thing under test is whether the
  // algorithm is linear, not how busy the machine is.
  function bestMs(fn, runs = 5) {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const start = process.hrtime.bigint();
      fn();
      best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
    }
    return best;
  }

  for (const c of FIXTURE.redos) {
    test(`${c.label} completes within ${c.max_ms}ms`, () => {
      const input = c.unit.repeat(c.count) + c.suffix;
      const ms = bestMs(() => redactCredentials(input));
      assert.ok(ms < c.max_ms, `took ${ms.toFixed(3)}ms, budget ${c.max_ms}ms`);
    });
  }
});

describe('resolveConfiguredDbPath', () => {
  test('DB_PATH wins over DATABASE_URL and VOXIKIN_DB', () => {
    const env = { DB_PATH: '/a.db', DATABASE_URL: '/b.db', VOXIKIN_DB: '/c.db' };
    const result = resolveConfiguredDbPath(['DB_PATH', 'DATABASE_URL', 'VOXIKIN_DB'], env);
    assert.deepStrictEqual(result, { value: '/a.db', varName: 'DB_PATH' });
  });

  test('falls through to the next name when an earlier one is unset', () => {
    const env = { VOXIKIN_DB: '/c.db' };
    const result = resolveConfiguredDbPath(['DB_PATH', 'DATABASE_URL', 'VOXIKIN_DB'], env);
    assert.deepStrictEqual(result, { value: '/c.db', varName: 'VOXIKIN_DB' });
  });

  test('returns a null varName when nothing is set', () => {
    const result = resolveConfiguredDbPath(['DB_PATH'], {});
    assert.deepStrictEqual(result, { value: undefined, varName: null });
  });

  test('only consults the names it is given — ground-truth.js never reads VOXIKIN_DB', () => {
    const env = { VOXIKIN_DB: '/shared.db' };
    const result = resolveConfiguredDbPath(['DB_PATH', 'DATABASE_URL'], env);
    assert.deepStrictEqual(result, { value: undefined, varName: null });
  });
});
