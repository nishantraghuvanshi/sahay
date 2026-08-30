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

  test('a plain filesystem path passes through untouched', () => {
    assert.strictEqual(redactCredentials('/data/voiceagent.db'), '/data/voiceagent.db');
  });

  test('a path with "@" but no scheme is untouched', () => {
    assert.strictEqual(redactCredentials('/tmp/a@b/x.db'), '/tmp/a@b/x.db');
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
