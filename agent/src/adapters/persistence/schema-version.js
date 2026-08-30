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
 * algorithm against the same file; there is no shared runtime. Both parse
 * schema.sql the same way, and — this is the part that is actually enforced
 * — both test suites assert against ONE shared table of database shapes,
 * api/fixtures/schema-verdict-cases.json. "Kept in step by the tests on each
 * side" is what the sibling pair (utils/db-path.js and api/db_path.py)
 * claimed while drifting in opposite directions for four review rounds,
 * because neither suite ever ran the other's inputs.
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

  // Minor fix, round 1: tableRe requires a closing "\n);" — a future table
  // whose closing "); " lands on the same line as its last column (no
  // newline before it) would silently vanish from this authority's output
  // instead of failing loudly, and every open of every database would then
  // treat that table as though schema.sql never declared it. Count
  // "CREATE TABLE IF NOT EXISTS" occurrences independently of the paired
  // regex and refuse to proceed on a mismatch, rather than trusting the
  // paired regex found everything it should have.
  const declaredCount = (schemaSql.match(/CREATE TABLE IF NOT EXISTS \w+/g) || []).length;
  const parsedCount = Object.keys(tables).length;
  if (parsedCount !== declaredCount) {
    throw new Error(
      `parseTableColumns found ${parsedCount} table(s) but schema.sql declares ` +
        `${declaredCount} — a CREATE TABLE statement failed to parse (its closing ");" ` +
        `may not be on its own line). Refusing to derive a partial column list from the ` +
        `single source of truth rather than silently dropping a table.`
    );
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
 * migration in place.
 *
 * What "refused" means depends on WHICH refusal fires, and the two are not
 * the same guarantee:
 *
 *   - A pre-rename column name, a mismatched primary-key type, or a
 *     user_version from the future is refused with NOTHING WRITTEN. Those
 *     checks all run before the first statement is executed, so the file on
 *     disk is left byte-identical.
 *   - An incomplete migration (a column SQLite cannot safely ALTER in, or an
 *     index that depended on one) is refused AFTER the schema script has
 *     run: columns that could be added safely have been added, and any
 *     wholly-new table and index has been created. Only `PRAGMA
 *     user_version` is withheld — the claim "this database is fully current"
 *     — so the refusal repeats deterministically on every subsequent open
 *     instead of the gap becoming permanent and invisible. The additive
 *     changes left behind are harmless on their own; existing rows are
 *     untouched.
 *
 * This docstring used to say only "an incompatible database is refused with
 * nothing written", which was true before the incomplete-migration refusal
 * existed and false after it. A stale comment about a safety guarantee is
 * worse than none.
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
    // liveId.type is '' for an untyped column (e.g. `id PRIMARY KEY` with no
    // type keyword) — that already compares unequal to wantType and refuses
    // correctly (an untyped id is not a TEXT id), but rendered as "id is ,
    // schema requires TEXT" with nothing between "is" and the comma. Fix
    // round 1, finding 3: label it explicitly instead.
    if (liveId && liveId.type.toUpperCase() !== wantType.toUpperCase()) {
      const typeLabel = liveId.type || '(untyped)';
      problems.push(`${table}.id is ${typeLabel}, schema requires ${wantType}`);
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

  // Deviation from the brief, ruled on deliberately (fix round 1, finding
  // 4 — not an oversight): task-4-brief.md says "Version 0 (no marker,
  // pre-reconciliation) is incompatible." This code instead falls through
  // to the migratable branch below for a version-0 database whose SHAPE is
  // otherwise compatible (right PK types, no pre-rename column names) — the
  // rename/PK-type checks above already ran and would have refused it if
  // it actually were the pre-reconciliation shape. A strict reading of the
  // brief would refuse every database that predates this task (there was
  // no marker anywhere before it), including every currently-working dev
  // database, and would make the `migratable` verdict unreachable at
  // target=1 since there is no version 0.5 to migrate from. Ruled that the
  // behaviour stands: "version 0" in the brief means the specific
  // pre-reconciliation shape, which the shape checks already catch by
  // construction, not literally every database that has never had a
  // version stamped on it.
  //
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
  // be created either — that failure is caught, not swallowed: see below.
  const skippedIndexes = _createTablesAndIndexes(db, schemaSql, existing);

  // Fix round 1, finding 1: this used to stamp user_version unconditionally
  // here, regardless of `skipped`/`skippedIndexes` — so a migration that
  // knowingly could not add a column, or could not create an index that
  // depended on it (idx_meds_patient_name_start is UNIQUE — the exact
  // idempotency guarantee TRD §3.1 requires), still recorded the database
  // as fully current. Every later open then took the `current` branch
  // above and returned instantly: the gap became permanent and invisible,
  // which is precisely the failure this whole task exists to remove.
  //
  // Folded into the `incompatible` verdict rather than adding a fourth one:
  // the brief specifies three verdicts, and an unstamped, retried-on-every-
  // open refusal already delivers "visible on every subsequent open" — no
  // separate `incomplete` bookkeeping is needed for that. The columns that
  // WERE safely added above are left in place (they are harmless additive
  // changes on their own); only the version stamp — the claim "this
  // database is fully current" — is withheld. A future open of this same
  // database re-runs this exact code path (found_version is still behind
  // target, tables still exist), gets the same added/skipped verdict again
  // deterministically, and throws again — that is what makes it visible on
  // every open rather than once, not a stored "incomplete" flag.
  if (skipped.length > 0 || skippedIndexes.length > 0) {
    throw new IncompatibleDatabaseError(
      `Refusing to certify ${dbLabel} as migrated to version ${targetVersion} ` +
        `(found user_version=${foundVersion}): the migration could not complete safely. ` +
        `${skipped.length} column(s) could not be added — ${skipped.join(', ') || 'none'} — ` +
        `${skippedIndexes.length} index statement(s) could not run as a result. ` +
        `SQLite cannot ALTER TABLE ADD COLUMN a NOT NULL column with no DEFAULT, or any ` +
        `column whose DEFAULT is not a constant, onto a table that already has rows. ` +
        `user_version was left unchanged so this refusal repeats on every open until the ` +
        `database is rebuilt — do not treat this as transient.`
    );
  }

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
