'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  parseSchemaVersion,
  parseRenames,
  parseTableColumns,
  checkAndMigrate,
  IncompatibleDatabaseError,
} = require('../src/adapters/persistence/schema-version');

/**
 * spec: .superpowers/sdd/modularise-boundaries/task-4-brief.md
 *
 * One version marker, one authority (api/schema.sql), three verdicts:
 * current / migratable / incompatible. Covers the parsing helpers and the
 * verdict logic against temp databases built to each shape, plus the real
 * pre-reconciliation database as evidence for the incompatible case.
 */

const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'api', 'schema.sql'),
  'utf8'
);

const tmpFiles = [];
function tmpDbPath(prefix) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'test.db');
  tmpFiles.push(p);
  return p;
}
after(() => {
  for (const p of tmpFiles) fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

describe('parsing api/schema.sql', () => {
  test('parseSchemaVersion reads the SCHEMA_VERSION marker', () => {
    assert.strictEqual(parseSchemaVersion(SCHEMA_SQL), 1);
  });

  test('parseSchemaVersion throws without a marker', () => {
    assert.throws(() => parseSchemaVersion('-- no marker here'), /SCHEMA_VERSION/);
  });

  test('parseRenames reads the documented medications renames', () => {
    const renames = parseRenames(SCHEMA_SQL);
    assert.deepStrictEqual(renames, [
      { table: 'medications', oldName: 'times', newName: 'slots' },
      { table: 'medications', oldName: 'food_rule', newName: 'with_food' },
    ]);
  });

  test('parseTableColumns finds all 18 tables with their declared columns', () => {
    const tables = parseTableColumns(SCHEMA_SQL);
    assert.strictEqual(Object.keys(tables).length, 18);
    const medCols = tables.medications.map((c) => c.name);
    assert.ok(medCols.includes('slots'));
    assert.ok(medCols.includes('with_food'));
    assert.ok(!medCols.includes('times'), 'the old name must not appear as a declared column');
    // a CHECK(... IN (...)) column must survive as one column, not split on
    // the comma inside the parens
    const otpCols = tables.auth_otp.map((c) => c.name);
    assert.deepStrictEqual(
      otpCols,
      ['id', 'channel', 'destination', 'code_hash', 'expires_at', 'attempts', 'consumed_at', 'request_ip', 'created_at']
    );
  });
});

describe('verdict: current (fresh database)', () => {
  test('a brand new file gets the full schema and the target version', () => {
    const dbPath = tmpDbPath('sahay-schema-version-fresh-');
    const db = new DatabaseSync(dbPath);
    const result = checkAndMigrate(db, SCHEMA_SQL, dbPath);
    assert.strictEqual(result.verdict, 'created');
    assert.strictEqual(result.version, 1);
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('patients'));
    assert.ok(tables.includes('payments'));
    db.close();
  });

  test('opening an already-current database a second time is a no-op verdict', () => {
    const dbPath = tmpDbPath('sahay-schema-version-current-');
    const db = new DatabaseSync(dbPath);
    checkAndMigrate(db, SCHEMA_SQL, dbPath);
    const second = checkAndMigrate(db, SCHEMA_SQL, dbPath);
    assert.strictEqual(second.verdict, 'current');
    db.close();
  });
});

describe('verdict: migratable (additive-behind, and it actually completes)', () => {
  test('a compatible database missing only safely-addable gap columns gets them added, and the version bumped', () => {
    const dbPath = tmpDbPath('sahay-schema-version-migratable-');
    const db = new DatabaseSync(dbPath);
    // TEXT id, current column names, stripped to only the columns that
    // existed before the caregiver-app gap columns were added — every one
    // of those gap columns is nullable or DEFAULT-constant (fix round 1,
    // finding 1's fixture deliberately avoids medications' NOT-NULL-no-
    // DEFAULT and non-constant-DEFAULT columns, which is a separate,
    // now-refusing case covered below).
    db.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    const result = checkAndMigrate(db, SCHEMA_SQL, dbPath);
    assert.strictEqual(result.verdict, 'migrated');
    assert.strictEqual(result.from, 0);
    assert.strictEqual(result.version, 1);
    assert.ok(result.added.includes('patients.timezone'));
    assert.ok(result.added.includes('patients.caregiver_id'));
    assert.deepStrictEqual(result.skipped, []);
    assert.deepStrictEqual(result.skippedIndexes, []);
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.close();
  });
});

describe('verdict: incompatible (a migration that cannot complete safely)', () => {
  // Fix round 1, finding 1: this used to be "never attempts to add a NOT
  // NULL column with no DEFAULT — it is skipped, not thrown", asserting a
  // `migrated` verdict with `skipped` columns AND user_version stamped
  // anyway. That stamped the database as fully current despite a stranded
  // UNIQUE index gap (idx_meds_patient_name_start needs start_date, which
  // cannot be safely ALTERed) — every later open then took the fast
  // `current` path and the gap became permanent and invisible. Fixed to
  // refuse instead, and to refuse identically on every subsequent open.
  test('a column SQLite cannot safely ALTER in is refused, not silently certified as migrated', () => {
    const dbPath = tmpDbPath('sahay-schema-version-skip-unsafe-');
    const db = new DatabaseSync(dbPath);
    // A pathologically stripped table: missing patient_id, which schema.sql
    // declares NOT NULL with no DEFAULT. Adding it via ALTER TABLE against a
    // populated table would throw if attempted; the migration must refuse
    // to certify the database as migrated rather than attempt it.
    db.exec(`
      CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO medications (id, name) VALUES ('m1', 'Metformin');
    `);

    assert.throws(() => checkAndMigrate(db, SCHEMA_SQL, dbPath), IncompatibleDatabaseError);
    // user_version must NOT be stamped — this is the whole point of the fix.
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 0);
    // The existing row survives untouched; only safe additive columns may
    // have been added alongside the refusal (harmless on their own).
    assert.strictEqual(
      db.prepare("SELECT name FROM medications WHERE id = 'm1'").get().name,
      'Metformin',
      'the existing row must survive untouched'
    );

    // Visible on EVERY subsequent open, not once: re-running the exact same
    // check against the same (still-unstamped) database throws again,
    // identically — this is what makes the gap impossible to miss on a
    // real restart, rather than a one-time warning nobody sees again.
    assert.throws(() => checkAndMigrate(db, SCHEMA_SQL, dbPath), IncompatibleDatabaseError);
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 0);
    db.close();
  });

  test('the refusal message names which columns and how many index statements could not complete', () => {
    const dbPath = tmpDbPath('sahay-schema-version-skip-message-');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);
    `);
    let error;
    try {
      checkAndMigrate(db, SCHEMA_SQL, dbPath);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof IncompatibleDatabaseError);
    assert.match(error.message, /medications\.patient_id/);
    assert.match(error.message, /medications\.dose/);
    assert.match(error.message, /index statement\(s\) could not run/);
    db.close();
  });
});

describe('verdict: incompatible', () => {
  test('an INTEGER primary key where the schema says TEXT is refused, and nothing is written', () => {
    const dbPath = tmpDbPath('sahay-schema-version-integer-pk-');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_e164 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    assert.throws(() => checkAndMigrate(db, SCHEMA_SQL, dbPath), IncompatibleDatabaseError);
    // nothing was written: no new columns, no version marker set
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 0);
    const cols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
    assert.deepStrictEqual(cols, ['id', 'phone_e164', 'created_at']);
    db.close();
  });

  test('an untyped id column is refused too, not just a mismatched-type one (fix round 1, finding 3)', () => {
    const dbPath = tmpDbPath('sahay-schema-version-untyped-pk-');
    const db = new DatabaseSync(dbPath);
    // `id PRIMARY KEY` with no type keyword — PRAGMA table_info reports its
    // type as the empty string. An untyped id is not a TEXT id.
    db.exec(`
      CREATE TABLE patients (
        id PRIMARY KEY,
        phone_e164 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    let error;
    try {
      checkAndMigrate(db, SCHEMA_SQL, dbPath);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof IncompatibleDatabaseError);
    assert.match(error.message, /patients\.id is \(untyped\), schema requires TEXT/);
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 0);
    db.close();
  });

  test('a pre-rename column name (medications.times) is refused, never auto-added beside slots', () => {
    const dbPath = tmpDbPath('sahay-schema-version-rename-');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE medications (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        name TEXT NOT NULL,
        dose TEXT NOT NULL,
        times TEXT NOT NULL DEFAULT '[]',
        food_rule TEXT
      );
    `);
    db.exec(`INSERT INTO medications (id, patient_id, name, dose, times) VALUES ('m1','p1','Metformin','500mg','[\"08:00\"]')`);
    let error;
    try {
      checkAndMigrate(db, SCHEMA_SQL, dbPath);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof IncompatibleDatabaseError);
    assert.match(error.message, /medications\.times/);
    // the real bug this guards: 'slots' must never appear beside 'times'
    const cols = db.prepare('PRAGMA table_info(medications)').all().map((c) => c.name);
    assert.ok(!cols.includes('slots'), 'slots must never be auto-added beside a populated times column');
    assert.strictEqual(
      db.prepare("SELECT times FROM medications WHERE id = 'm1'").get().times,
      '["08:00"]',
      'the real schedule data must be untouched'
    );
    db.close();
  });

  test('a future user_version this code does not understand is refused', () => {
    const dbPath = tmpDbPath('sahay-schema-version-future-');
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    db.exec('PRAGMA user_version = 999');
    assert.throws(() => checkAndMigrate(db, SCHEMA_SQL, dbPath), IncompatibleDatabaseError);
    db.close();
  });

  test('the real pre-reconciliation database is refused, and the original file on disk is untouched', () => {
    const original = path.join(__dirname, '..', 'data', 'voiceagent.db.pre-reconciliation-1300');
    if (!fs.existsSync(original)) {
      // Evidence file only exists on the machine this task was done on;
      // skip rather than fail elsewhere.
      return;
    }
    const beforeStat = fs.statSync(original);
    const beforeBytes = fs.readFileSync(original);

    const copyPath = tmpDbPath('sahay-schema-version-real-copy-');
    fs.copyFileSync(original, copyPath);
    const db = new DatabaseSync(copyPath);

    let error;
    try {
      checkAndMigrate(db, SCHEMA_SQL, copyPath);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof IncompatibleDatabaseError);
    assert.match(error.message, /user_version=0/);
    assert.match(error.message, /required=1/);
    assert.match(error.message, /medications\.times/);
    assert.match(error.message, /medications\.id is INTEGER/);
    db.close();

    // the original evidence file was never opened by this test — only the copy was
    const afterStat = fs.statSync(original);
    const afterBytes = fs.readFileSync(original);
    assert.strictEqual(beforeStat.size, afterStat.size);
    assert.deepStrictEqual(beforeBytes, afterBytes);
  });
});

/**
 * The shared cross-runtime parity fixture. api/fixtures/schema-verdict-cases.json
 * lists database shape -> expected verdict, and api/tests/test_schema_version.py
 * runs the SAME table against api/schema_version.py.
 *
 * This exists because the sibling pair of this module (utils/db-path.js and
 * api/db_path.py) was also "kept in step by the tests on each side" — and
 * drifted for four review rounds, in opposite directions, because neither
 * suite ever ran the other's inputs. A comment claiming parity is not
 * enforcement; a file both sides read is. Add a shape to the fixture, not to
 * one suite.
 *
 * The bespoke tests above stay: they assert runtime-specific things the
 * fixture deliberately cannot carry (row survival through a refusal, the
 * repeat-refusal on every open, and the real pre-reconciliation evidence
 * file on disk).
 */
const VERDICT_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'api', 'fixtures', 'schema-verdict-cases.json'),
    'utf8'
  )
);

function applyVerdictCase(db, c) {
  if (c.setup_sql) db.exec(c.setup_sql);
  if (c.pre_migrate) checkAndMigrate(db, SCHEMA_SQL, 'pre-migrate');
  if (c.user_version !== null && c.user_version !== undefined) {
    db.exec(`PRAGMA user_version = ${c.user_version}`);
  }
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

describe('verdict parity — the shared fixture both runtimes read', () => {
  test('the fixture is present and non-trivial — an empty one must not read as a pass', () => {
    assert.ok(Array.isArray(VERDICT_FIXTURE.cases), 'fixture has no cases[]');
    assert.strictEqual(VERDICT_FIXTURE.cases.length, 8, 'expected the 8 documented shapes');
    for (const verdict of ['created', 'current', 'migrated', 'incompatible']) {
      assert.ok(
        VERDICT_FIXTURE.cases.some((c) => c.expect.verdict === verdict),
        `fixture covers no ${verdict} case`
      );
    }
  });

  for (const c of VERDICT_FIXTURE.cases) {
    test(`${c.expect.verdict}: ${c.label}`, () => {
      const dbPath = tmpDbPath('sahay-schema-verdict-fixture-');
      const db = new DatabaseSync(dbPath);
      try {
        applyVerdictCase(db, c);

        if (c.expect.verdict === 'incompatible') {
          let error;
          try {
            checkAndMigrate(db, SCHEMA_SQL, dbPath);
          } catch (e) {
            error = e;
          }
          assert.ok(error instanceof IncompatibleDatabaseError, `expected a refusal for ${c.label}`);
          for (const pattern of c.expect.message_matches || []) {
            assert.match(error.message, new RegExp(pattern));
          }
          for (const pattern of c.expect.message_not_matches || []) {
            assert.doesNotMatch(error.message, new RegExp(pattern));
          }
        } else {
          const result = checkAndMigrate(db, SCHEMA_SQL, dbPath);
          assert.strictEqual(result.verdict, c.expect.verdict);
          if (c.expect.version !== undefined) assert.strictEqual(result.version, c.expect.version);
          if (c.expect.from !== undefined) assert.strictEqual(result.from, c.expect.from);
          for (const col of c.expect.added_includes || []) {
            assert.ok(result.added.includes(col), `expected ${col} among added`);
          }
          if (c.expect.skipped) assert.deepStrictEqual(result.skipped, c.expect.skipped);
          // JS spells it skippedIndexes; the fixture uses the shared snake_case name.
          if (c.expect.skipped_indexes) {
            assert.deepStrictEqual(result.skippedIndexes, c.expect.skipped_indexes);
          }
        }

        if (c.expect.user_version_after !== undefined) {
          assert.strictEqual(
            db.prepare('PRAGMA user_version').get().user_version,
            c.expect.user_version_after
          );
        }
        for (const [table, cols] of Object.entries(c.expect.columns_exactly || {})) {
          assert.deepStrictEqual(tableColumns(db, table), cols);
        }
        for (const [table, cols] of Object.entries(c.expect.columns_absent || {})) {
          const live = tableColumns(db, table);
          for (const col of cols) {
            assert.ok(!live.includes(col), `${table}.${col} must not have been added`);
          }
        }
        for (const table of c.expect.tables_present || []) {
          const names = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name);
          assert.ok(names.includes(table), `expected table ${table}`);
        }
      } finally {
        db.close();
      }
    });
  }
});

describe('the refusal names a real route back out (finding 6)', () => {
  const RECOVERY = VERDICT_FIXTURE.recovery_instruction;

  function refusalFor(dbLabel) {
    const dbPath = tmpDbPath('sahay-schema-recovery-');
    const db = new DatabaseSync(dbPath);
    try {
      // The incomplete-migration shape: medications missing patient_id (NOT
      // NULL, no DEFAULT) and start_date (DEFAULT (date('now')), never
      // ALTER-addable), on a table that already has rows.
      db.exec(`
        CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);
        INSERT INTO medications (id, name) VALUES ('m1', 'Metformin');
      `);
      checkAndMigrate(db, SCHEMA_SQL, dbLabel);
      assert.fail('expected a refusal');
    } catch (e) {
      if (!(e instanceof IncompatibleDatabaseError)) throw e;
      return e.message;
    } finally {
      db.close();
    }
  }

  test('carries the wording both runtimes share', () => {
    const message = refusalFor('/data/voiceagent.db');
    for (const pattern of RECOVERY.shared_matches) {
      assert.match(message, new RegExp(pattern));
    }
  });

  test('names the command that actually recreates the schema on THIS runtime', () => {
    // server.js reaches checkAndMigrate's `created` branch through
    // SqliteRepository on every boot, and that branch execs api/schema.sql
    // whole — so `npm start` against an absent file genuinely rebuilds. There
    // is no `npm run db:reset` to point at instead; see _recoveryInstruction.
    assert.match(refusalFor('/data/voiceagent.db'), new RegExp(RECOVERY.per_runtime.node));
  });

  test('names the actual path, so an operator can paste the command', () => {
    const message = refusalFor('/data/voiceagent.db');
    assert.ok(
      message.includes('mv "/data/voiceagent.db" "/data/voiceagent.db.superseded"'),
      `the command is not runnable as written: ${message}`
    );
  });

  test('the primary instruction is never destructive', () => {
    // A refused database may be the only copy of a patient's medication
    // schedule, and no refusal in this module modified its rows. Move aside,
    // never delete.
    const message = refusalFor('/data/voiceagent.db');
    for (const forbidden of RECOVERY.forbidden) {
      assert.ok(!message.includes(forbidden), `destructive instruction ${forbidden}: ${message}`);
    }
  });

  test('a credential-bearing label is redacted, in the message AND in the command', () => {
    const { db_label, expected_in_message, forbidden_in_message } = RECOVERY.label_is_redacted;
    const message = refusalFor(db_label);
    assert.ok(message.includes(expected_in_message), `label not redacted: ${message}`);
    for (const forbidden of forbidden_in_message) {
      assert.ok(!message.includes(forbidden), `${forbidden} leaked into the refusal: ${message}`);
    }
  });
});
