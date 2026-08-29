'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertPersistenceSatisfied,
} = require('../src/core/persistence-guard');
const ConsoleRepository = require('../src/adapters/persistence/console');
const SqliteRepository = require('../src/adapters/persistence/sqlite');
const OutcomeRepositoryPort = require('../src/core/ports/repository');

/**
 * A use case that needs persistence must not boot without it.
 *
 * Inbound context and resume are entirely persistence features. With
 * ConsoleRepository the agent would greet a known caller as a stranger and
 * sound completely fine doing it — plausible output, wrong behaviour, no
 * signal. Failing at boot puts the error where it is cheapest to notice.
 */

describe('repository persistence capability', () => {
  test('ConsoleRepository reports it does not persist', () => {
    assert.strictEqual(new ConsoleRepository().isPersistent, false);
  });

  test('SqliteRepository reports it persists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-guard-'));
    const repo = new SqliteRepository({ dbPath: path.join(dir, 'x.db') });
    assert.strictEqual(repo.isPersistent, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the port defaults to not persistent', () => {
    class Bare extends OutcomeRepositoryPort {}
    assert.strictEqual(new Bare().isPersistent, false);
  });
});

describe('assertPersistenceSatisfied', () => {
  const persistent = { isPersistent: true };
  const ephemeral = { isPersistent: false };

  test('passes when the use case needs persistence and has it', () => {
    assert.doesNotThrow(() =>
      assertPersistenceSatisfied({ name: 'x', requiresPersistence: true }, persistent)
    );
  });

  test('passes when the use case does not need persistence', () => {
    assert.doesNotThrow(() =>
      assertPersistenceSatisfied({ name: 'x', requiresPersistence: false }, ephemeral)
    );
  });

  test('throws when the use case needs persistence and lacks it', () => {
    assert.throws(
      () => assertPersistenceSatisfied({ name: 'medication-adherence', requiresPersistence: true }, ephemeral),
      /medication-adherence/
    );
  });

  test('the error names DB_PATH so the fix is obvious', () => {
    assert.throws(
      () => assertPersistenceSatisfied({ name: 'x', requiresPersistence: true }, ephemeral),
      /DB_PATH/
    );
  });
});

describe('medication-adherence declares its persistence need', () => {
  const useCase = require('../src/use-cases/medication-adherence');

  test('requiresPersistence is true', () => {
    assert.strictEqual(
      useCase.requiresPersistence,
      true,
      'inbound context and resume cannot work without a database'
    );
  });
});

describe('ConsoleRepository implements the full port surface', () => {
  // Swapping persistence must never crash on a missing method. Console is
  // allowed to return nothing; it is not allowed to be missing the method.
  const METHODS = [
    'save',
    'list',
    'upsertPatient',
    'findPatientByPhone',
    'listPatients',
    'createSession',
    'getSession',
    'listSessions',
    'endSession',
    'getSessionFields',
    'updateSessionFields',
    'findResumableSession',
    'expireStaleSessions',
    'recentCallsForPhone',
  ];

  for (const method of METHODS) {
    test(`implements ${method}()`, () => {
      assert.strictEqual(typeof new ConsoleRepository()[method], 'function');
    });
  }

  test('lookups return empty rather than throwing', async () => {
    const repo = new ConsoleRepository();
    assert.strictEqual(await repo.findPatientByPhone('+910000000000'), null);
    assert.deepStrictEqual(await repo.listPatients(), []);
    assert.strictEqual(await repo.findResumableSession(1, 15), null);
    assert.deepStrictEqual(await repo.recentCallsForPhone('+910000000000'), []);
  });
});
