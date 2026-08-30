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

describe('verdict: migratable (additive-behind)', () => {
  test('a compatible database missing gap columns gets them added, and the version bumped', () => {
    const dbPath = tmpDbPath('sahay-schema-version-migratable-');
    const db = new DatabaseSync(dbPath);
    // TEXT ids, current column names, but stripped down to only the columns
    // that existed before the gap columns were added — an honestly
    // additive-behind shape, never a rename.
    db.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE medications (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        name TEXT NOT NULL,
        dose TEXT NOT NULL
      );
    `);
    const result = checkAndMigrate(db, SCHEMA_SQL, dbPath);
    assert.strictEqual(result.verdict, 'migrated');
    assert.strictEqual(result.from, 0);
    assert.strictEqual(result.version, 1);
    assert.ok(result.added.includes('patients.timezone'));
    assert.ok(result.added.includes('medications.slots'));
    // patient_id/dose are NOT NULL with no DEFAULT on medications, and
    // already exist on this table anyway; assert the guard never tried to
    // add a NOT-NULL-no-DEFAULT column that was genuinely missing.
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.close();
  });

  test('never attempts to add a NOT NULL column with no DEFAULT — it is skipped, not thrown', () => {
    const dbPath = tmpDbPath('sahay-schema-version-skip-unsafe-');
    const db = new DatabaseSync(dbPath);
    // A pathologically stripped table: missing patient_id, which schema.sql
    // declares NOT NULL with no DEFAULT. Adding it via ALTER TABLE against a
    // populated table would throw; the migration must skip it instead.
    db.exec(`
      CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO medications (id, name) VALUES ('m1', 'Metformin');
    `);
    const result = checkAndMigrate(db, SCHEMA_SQL, dbPath);
    assert.strictEqual(result.verdict, 'migrated');
    assert.ok(result.skipped.includes('medications.patient_id'));
    assert.ok(result.skipped.includes('medications.dose'));
    assert.ok(result.added.includes('medications.slots')); // has a DEFAULT — safe
    assert.strictEqual(
      db.prepare("SELECT name FROM medications WHERE id = 'm1'").get().name,
      'Metformin',
      'the existing row must survive untouched'
    );
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
