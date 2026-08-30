'use strict';

/**
 * Schema version parsing and the open-time verdict. spec:
 * .superpowers/sdd/modularise-boundaries/task-4-brief.md
 *
 * api/schema.sql is the single authority for the target schema: both the
 * target version number and the additive column list are read out of it
 * rather than hand-maintained here. That is what replaces the two
 * independent, disagreeing lists this task removes (sqlite.js's
 * _ensureColumn calls and api/db.py's _ADDED_COLUMNS).
 *
 * The Python counterpart (api/schema_version.py) implements the same
 * algorithm against the same file; there is no shared runtime, so the two
 * are kept in step by both parsing schema.sql the same way and by the tests
 * on each side.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', '..', 'api', 'schema.sql');

class IncompatibleDatabaseError extends Error {}

function readSchemaSql(schemaPath = SCHEMA_PATH) {
  return fs.readFileSync(schemaPath, 'utf8');
}

function parseSchemaVersion(schemaSql) {
  const m = schemaSql.match(/SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!m) {
    throw new Error('api/schema.sql has no "SCHEMA_VERSION = N" marker');
  }
  return Number(m[1]);
}

/** @returns {Array<{table: string, oldName: string, newName: string}>} */
function parseRenames(schemaSql) {
  const m = schemaSql.match(/RENAMES:\s*(.+)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [tableCol, newName] = entry.split('->').map((s) => s.trim());
      const [table, oldName] = tableCol.split('.').map((s) => s.trim());
      return { table, oldName, newName };
    });
}

/** Strip `-- ...` line comments so they never get parsed as column syntax. */
function _stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/** Split on top-level commas only — a CHECK(col IN ('a','b')) must stay one column. */
function _splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * @returns {Object<string, Array<{name: string, decl: string}>>} table name
 *   -> declared columns, in schema.sql's CREATE TABLE order.
 */
function parseTableColumns(schemaSql) {
  const tables = {};
  const tableRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let match;
  while ((match = tableRe.exec(schemaSql))) {
    const [, tableName, body] = match;
    const cols = [];
    for (const part of _splitTopLevel(_stripComments(body))) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const colMatch = trimmed.match(/^(\w+)\s+([\s\S]+)$/);
      if (!colMatch) continue; // a standalone table-level constraint, if one ever appears
      cols.push({ name: colMatch[1], decl: colMatch[2].trim() });
    }
    tables[tableName] = cols;
  }
  return tables;
}

/**
 * A column safe to ALTER onto a table that may already have rows. SQLite
 * refuses ALTER TABLE ADD COLUMN for a NOT NULL column with no DEFAULT
 * (unless the table is empty, which a migrating table generally isn't), and
 * separately refuses ANY column — NOT NULL or not — whose DEFAULT is not a
 * constant, e.g. `DEFAULT (date('now'))`. medications.start_date and both
 * `calls`/`messages`.created_at declare exactly that shape in schema.sql;
 * skipping them here (rather than crashing the whole migration) is
 * deliberate, not an oversight — see the comment on the caller.
 */
function _isSafeToAdd(decl) {
  const upper = decl.toUpperCase();
  if (upper.includes('NOT NULL') && !upper.includes('DEFAULT')) return false;
  if (/DEFAULT\s*\(/i.test(decl)) return false;
  if (/DEFAULT\s+CURRENT_(TIME|DATE|TIMESTAMP)/i.test(decl)) return false;
  return true;
}

/**
 * Split schema.sql into its top-level statements, walking line by line so a
 * ';' inside a `-- comment` (schema.sql's prose is full of them — "on the
 * next screen;" is real text here) is never mistaken for a statement
 * terminator. A statement ends on the first line whose CODE portion (the
 * text before any '--' on that line) itself ends with ';'. Not a general
 * SQL-statement splitter — this file has no semicolon inside a string
 * literal, which a general splitter would need to handle and this doesn't.
 */
function _splitStatements(schemaSql) {
  const statements = [];
  let current = [];
  for (const line of schemaSql.split('\n')) {
    current.push(line);
    const commentIdx = line.indexOf('--');
    const codePart = commentIdx === -1 ? line : line.slice(0, commentIdx);
    if (/;\s*$/.test(codePart)) {
      statements.push(current.join('\n'));
      current = [];
    }
  }
  if (current.some((l) => l.trim())) statements.push(current.join('\n'));
  return statements;
}

/**
 * Create every table and index schema.sql declares, tolerating a CREATE
 * INDEX that fails because it references a column this migration had to
 * skip (see _isSafeToAdd) on a table that already existed. Table creation
 * is never allowed to fail silently — only an index statement's failure is
 * swallowed, and only after the table it targets is confirmed to already
 * exist (so the failure really is "missing column", not "missing table").
 *
 * @returns {string[]} indexes that could not be created, for the caller to log
 */
function _createTablesAndIndexes(db, schemaSql, existingBefore) {
  const skippedIndexes = [];
  for (const stmt of _splitStatements(schemaSql)) {
    // A statement chunk may start with the section-header comment above it
    // (e.g. "-- ============ calls ============\nCREATE TABLE ...") — strip
    // comment and blank lines before checking the leading keyword, but exec
    // the original text; SQLite is fine with comments in DDL.
    const body = _stripComments(stmt).trim();
    if (!/^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)/i.test(body)) continue;
    const isIndex = /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(body);
    if (!isIndex) {
      db.exec(stmt);
      continue;
    }
    const onExisting = /\bON\s+(\w+)/i.exec(stmt);
    const targetsPreexistingTable = onExisting && existingBefore.has(onExisting[1]);
    if (!targetsPreexistingTable) {
      db.exec(stmt); // a fresh table from this same migration — always safe
      continue;
    }
    try {
      db.exec(stmt);
    } catch (e) {
      skippedIndexes.push(`${stmt} (${e.message})`);
    }
  }
  return skippedIndexes;
}

function _existingTables(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
  );
}

/**
 * Decide current / migratable / incompatible for `db` and apply the
 * migration in place. Never executes a single statement before every
 * compatibility check has passed — an incompatible database is refused with
 * nothing written.
 *
 * @param {import('node:sqlite').DatabaseSync} db - already open
 * @param {string} schemaSql - api/schema.sql's contents
 * @param {string} dbLabel - path or description, for the error message only
 * @returns {{verdict: 'created'|'current'|'migrated', version: number, added?: string[], skipped?: string[]}}
 */
function checkAndMigrate(db, schemaSql, dbLabel) {
  const targetVersion = parseSchemaVersion(schemaSql);
  const renames = parseRenames(schemaSql);
  const declaredTables = parseTableColumns(schemaSql);

  const existing = _existingTables(db);

  if (existing.size === 0) {
    // A brand new file — nothing to migrate, nothing to lose.
    db.exec(schemaSql);
    db.exec(`PRAGMA user_version = ${targetVersion}`);
    return { verdict: 'created', version: targetVersion };
  }

  const foundVersion = db.prepare('PRAGMA user_version').get().user_version;

  const problems = [];
  for (const { table, oldName } of renames) {
    if (!existing.has(table)) continue;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === oldName)) {
      problems.push(
        `${table}.${oldName} is a pre-rename column name — this database predates the ${table} rename`
      );
    }
  }

  for (const table of existing) {
    const declared = declaredTables[table];
    if (!declared) continue;
    const pkCol = declared.find((c) => c.name === 'id' && /PRIMARY KEY/i.test(c.decl));
    if (!pkCol) continue;
    const wantType = (pkCol.decl.match(/^(\w+)/) || [])[1];
    if (!wantType) continue;
    const liveCols = db.prepare(`PRAGMA table_info(${table})`).all();
    const liveId = liveCols.find((c) => c.name === 'id');
    if (liveId && liveId.type.toUpperCase() !== wantType.toUpperCase()) {
      problems.push(`${table}.id is ${liveId.type}, schema requires ${wantType}`);
    }
  }

  if (problems.length > 0) {
    throw new IncompatibleDatabaseError(
      `Refusing to open ${dbLabel}: incompatible schema (found user_version=${foundVersion}, ` +
        `required=${targetVersion}). ${problems.join('; ')}. Rebuild the database — ` +
        `ALTER TABLE cannot fix this — rather than opening it as-is.`
    );
  }

  if (foundVersion > targetVersion) {
    throw new IncompatibleDatabaseError(
      `Refusing to open ${dbLabel}: found user_version=${foundVersion}, but this code only ` +
        `understands schema versions up to ${targetVersion}. Upgrade before opening this database.`
    );
  }

  if (foundVersion === targetVersion) {
    return { verdict: 'current', version: targetVersion };
  }

  // Migratable: add any column an existing table is missing FIRST — before
  // creating any wholly-new table or index, because schema.sql may declare
  // an index on a column an old table doesn't have yet
  // (idx_meds_patient_name_start references medications.start_date), and
  // CREATE INDEX has no "IF NOT EXISTS the referenced column" escape hatch.
  // Every check above has already passed, so a missing column here is a
  // genuine addition, never a stranded rename.
  const added = [];
  const skipped = [];
  for (const [table, cols] of Object.entries(declaredTables)) {
    if (!existing.has(table)) continue; // wholly new table — schema.sql below creates it whole
    const liveCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const { name, decl } of cols) {
      if (liveCols.has(name)) continue;
      if (!_isSafeToAdd(decl)) {
        skipped.push(`${table}.${name}`);
        continue;
      }
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      added.push(`${table}.${name}`);
    }
  }
  // Now safe to create any wholly-new table and every index that only
  // references columns that were either already there or just added above.
  // An index on a column this migration had to skip (_isSafeToAdd) cannot
  // be created either — that failure is caught and logged rather than
  // aborting the whole migration.
  const skippedIndexes = _createTablesAndIndexes(db, schemaSql, existing);
  db.exec(`PRAGMA user_version = ${targetVersion}`);
  return {
    verdict: 'migrated',
    version: targetVersion,
    from: foundVersion,
    added,
    skipped,
    skippedIndexes,
  };
}

module.exports = {
  SCHEMA_PATH,
  IncompatibleDatabaseError,
  readSchemaSql,
  parseSchemaVersion,
  parseRenames,
  parseTableColumns,
  checkAndMigrate,
};
