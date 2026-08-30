'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

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
 */

describe('assertFilesystemPath', () => {
  test('rejects a postgresql:// connection string', () => {
    assert.throws(
      () => assertFilesystemPath('postgresql://kinvox:kinvox@localhost:5432/kinvox', 'DB_PATH'),
      NotAFilesystemPathError
    );
  });

  test('rejects any <scheme>:// value, not just postgresql', () => {
    for (const scheme of ['postgres', 'mysql', 'sqlite', 'mongodb']) {
      assert.throws(
        () => assertFilesystemPath(`${scheme}://user:pass@host/db`, 'DATABASE_URL'),
        NotAFilesystemPathError,
        `expected ${scheme}:// to be rejected`
      );
    }
  });

  test('the error names the variable that was set', () => {
    assert.throws(
      () => assertFilesystemPath('postgresql://a:b@c/d', 'DATABASE_URL'),
      /DATABASE_URL/
    );
  });

  test('falls back to a generic label when no variable name is given', () => {
    assert.throws(() => assertFilesystemPath('postgresql://a:b@c/d'), /configured database path/);
  });

  test('the error message never contains the raw password', () => {
    try {
      assertFilesystemPath('postgresql://kinvox:supersecret@localhost:5432/kinvox', 'DB_PATH');
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(!e.message.includes('supersecret'), `password leaked: ${e.message}`);
    }
  });

  test('a plain absolute filesystem path is accepted', () => {
    assert.doesNotThrow(() => assertFilesystemPath('/data/voiceagent.db'));
  });

  test('a path containing ":" is accepted — a legal filesystem character', () => {
    assert.doesNotThrow(() => assertFilesystemPath('/tmp/backup:2026-08-30/x.db'));
  });

  test('a path containing "@" is accepted — the addendum\'s named example', () => {
    assert.doesNotThrow(() => assertFilesystemPath('/tmp/a@b/x.db'));
  });

  test('a relative path is accepted', () => {
    assert.doesNotThrow(() => assertFilesystemPath('./data/voiceagent.db'));
  });
});

describe('redactCredentials', () => {
  test('collapses everything after scheme:// so no password character survives', () => {
    const redacted = redactCredentials('postgresql://kinvox:secretpw@localhost:5432/kinvox');
    assert.ok(!redacted.includes('secretpw'));
    assert.ok(redacted.startsWith('postgresql://'));
  });

  // Round 4: a malformed-scheme input class every one of the three prior
  // rounds also missed, because redactCredentials fell through to
  // `return str` whenever the text before "://" wasn't a well-formed
  // scheme (empty, digit-led, or punctuation) instead of coarsening it —
  // the exact conditional the "coarsen by construction" ruling forbids.
  const LEAKING_INPUTS = [
    ['no scheme at all before ://', '://user:SECRET@host'],
    ['a digit-led scheme', '1abc://user:SECRET@host'],
    ['a punctuation-led scheme', '$$$://user:SECRET@host'],
    ['a scheme-shaped run after a real path prefix', '/mnt/1x://user:SECRET@host'],
  ];
  for (const [label, input] of LEAKING_INPUTS) {
    test(`${label} is still coarsened, not returned raw`, () => {
      const redacted = redactCredentials(input);
      assert.ok(!redacted.includes('SECRET'), `leaked: ${redacted}`);
      assert.ok(!redacted.includes('user:'), `leaked: ${redacted}`);
      // Not merely "the secret is gone": nothing of the original survives,
      // because a prefix that isn't a clean scheme may itself be a
      // mis-split credential.
      assert.strictEqual(redacted, '<redacted>://<redacted>');
    });
  }

  test('postgresql://u:s@h collapses to postgresql://<redacted>', () => {
    assert.strictEqual(redactCredentials('postgresql://u:s@h'), 'postgresql://<redacted>');
  });

  test('sqlite:///abs/path.db (no authority) is coarsened too', () => {
    assert.strictEqual(redactCredentials('sqlite:///abs/path.db'), 'sqlite://<redacted>');
  });

  test('an embedded scheme:// after a real path prefix redacts the secret, never rewrites into a false path', () => {
    const redacted = redactCredentials('/mnt/backups/scp://deploy:build@2024/release.db');
    assert.ok(!redacted.includes('build'));
    assert.ok(!redacted.includes('2024'));
  });

  test('a plain filesystem path passes through byte-identical', () => {
    assert.strictEqual(redactCredentials('/data/voiceagent.db'), '/data/voiceagent.db');
  });

  test('a path with "@" but no "://" passes through byte-identical', () => {
    assert.strictEqual(redactCredentials('/tmp/a@b/x.db'), '/tmp/a@b/x.db');
  });

  test('a path with ":" but no "://" passes through byte-identical', () => {
    assert.strictEqual(redactCredentials('/tmp/a:b/x.db'), '/tmp/a:b/x.db');
  });

  test('a relative path passes through byte-identical', () => {
    assert.strictEqual(redactCredentials('./data/v.db'), './data/v.db');
  });

  describe('never throws', () => {
    const EDGE_INPUTS = [
      ['null', null],
      ['undefined', undefined],
      ['a number', 5],
      ['an empty string', ''],
      ['a lone "://"', '://'],
      ['a null byte', '\u0000abc://x'],
      ['whitespace-padded', '   \t ://x   '],
      ['unicode', 'ünïcödé://x'],
      ['multi-megabyte with no "://"', 'a'.repeat(4000000)],
    ];
    for (const [label, input] of EDGE_INPUTS) {
      test(label, () => {
        assert.doesNotThrow(() => redactCredentials(input));
      });
    }
  });

  test('no ReDoS: a long scheme-char run with no "://" stays fast', () => {
    const huge = 'a'.repeat(4000000);
    const start = Date.now();
    redactCredentials(huge);
    assert.ok(Date.now() - start < 1000, 'redactCredentials(4M chars, no ://) took too long');
  });

  test('no ReDoS: a long scheme-char run immediately before "://" stays fast', () => {
    const huge = `${'a'.repeat(4000000)}://x`;
    const start = Date.now();
    redactCredentials(huge);
    assert.ok(Date.now() - start < 1000, 'redactCredentials(4M scheme chars + ://) took too long');
  });

  test('no ReDoS: many repetitions of "a://" stays fast', () => {
    const huge = 'a://'.repeat(1000000);
    const start = Date.now();
    redactCredentials(huge);
    assert.ok(Date.now() - start < 1000, 'redactCredentials(1M reps of a://) took too long');
  });
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
