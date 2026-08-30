"""Schema version parsing and the open-time verdict. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md

api/schema.sql is the single authority for the target schema: both the target
version number and the additive column list are read out of it rather than
hand-maintained here. That is what replaces the two independent, disagreeing
lists this task removes (sqlite.js's _ensureColumn calls and this module's
former _ADDED_COLUMNS).

The Node counterpart (agent/src/adapters/persistence/schema-version.js)
implements the same algorithm against the same file; there is no shared
runtime, so the two are kept in step by both parsing schema.sql the same way
and by the tests on each side.
"""
from __future__ import annotations

import re
import sqlite3

SCHEMA_VERSION_RE = re.compile(r"SCHEMA_VERSION\s*=\s*(\d+)")
RENAMES_RE = re.compile(r"RENAMES:\s*(.+)")
_TABLE_RE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);")
_COL_RE = re.compile(r"^(\w+)\s+([\s\S]+)$")


class IncompatibleDatabaseError(Exception):
    """Raised when an existing database cannot be safely opened."""


def parse_schema_version(schema_sql: str) -> int:
    m = SCHEMA_VERSION_RE.search(schema_sql)
    if not m:
        raise RuntimeError('api/schema.sql has no "SCHEMA_VERSION = N" marker')
    return int(m.group(1))


def parse_renames(schema_sql: str) -> list[tuple[str, str, str]]:
    """@returns [(table, old_name, new_name), ...]"""
    m = RENAMES_RE.search(schema_sql)
    if not m:
        return []
    out: list[tuple[str, str, str]] = []
    for entry in m.group(1).split(","):
        entry = entry.strip()
        if not entry:
            continue
        table_col, new_name = (part.strip() for part in entry.split("->"))
        table, old_name = (part.strip() for part in table_col.split("."))
        out.append((table, old_name, new_name))
    return out


def _strip_comments(text: str) -> str:
    """Strip `-- ...` line comments so they never get parsed as column syntax."""
    return "\n".join(line.split("--", 1)[0] for line in text.split("\n"))


def _split_top_level(text: str) -> list[str]:
    """Split on top-level commas only — a CHECK(col IN ('a','b')) must stay one column."""
    parts: list[str] = []
    current = ""
    depth = 0
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current)
    return parts


def parse_table_columns(schema_sql: str) -> dict[str, list[tuple[str, str]]]:
    """@returns table name -> declared [(column, decl), ...], CREATE TABLE order."""
    tables: dict[str, list[tuple[str, str]]] = {}
    for table_name, body in _TABLE_RE.findall(schema_sql):
        cols: list[tuple[str, str]] = []
        for part in _split_top_level(_strip_comments(body)):
            trimmed = part.strip()
            if not trimmed:
                continue
            m = _COL_RE.match(trimmed)
            if not m:
                continue  # a standalone table-level constraint, if one ever appears
            cols.append((m.group(1), m.group(2).strip()))
        tables[table_name] = cols
    return tables


_NON_CONSTANT_DEFAULT_RE = re.compile(r"DEFAULT\s*\(", re.IGNORECASE)
_CURRENT_TIME_DEFAULT_RE = re.compile(r"DEFAULT\s+CURRENT_(TIME|DATE|TIMESTAMP)", re.IGNORECASE)


def _is_safe_to_add(decl: str) -> bool:
    """A column safe to ALTER onto a table that may already have rows.
    SQLite refuses ALTER TABLE ADD COLUMN for a NOT NULL column with no
    DEFAULT (unless the table is empty, which a migrating table generally
    isn't), and separately refuses ANY column — NOT NULL or not — whose
    DEFAULT is not a constant, e.g. `DEFAULT (date('now'))`.
    medications.start_date and both `calls`/`messages`.created_at declare
    exactly that shape in schema.sql; skipping them here (rather than
    crashing the whole migration) is deliberate, not an oversight — see the
    comment on the caller.
    """
    upper = decl.upper()
    if "NOT NULL" in upper and "DEFAULT" not in upper:
        return False
    if _NON_CONSTANT_DEFAULT_RE.search(decl):
        return False
    if _CURRENT_TIME_DEFAULT_RE.search(decl):
        return False
    return True


def _split_statements(schema_sql: str) -> list[str]:
    """Split schema.sql into its top-level statements, walking line by line
    so a ';' inside a `-- comment` (schema.sql's prose is full of them — "on
    the next screen;" is real text here) is never mistaken for a statement
    terminator. A statement ends on the first line whose CODE portion (the
    text before any '--' on that line) itself ends with ';'. Not a general
    SQL-statement splitter — this file has no semicolon inside a string
    literal, which a general splitter would need to handle and this
    doesn't.
    """
    statements: list[str] = []
    current: list[str] = []
    for line in schema_sql.split("\n"):
        current.append(line)
        code_part = line.split("--", 1)[0]
        if code_part.rstrip().endswith(";"):
            statements.append("\n".join(current))
            current = []
    if any(line.strip() for line in current):
        statements.append("\n".join(current))
    return statements


_CREATE_TABLE_OR_INDEX_RE = re.compile(r"^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)", re.IGNORECASE)
_CREATE_INDEX_RE = re.compile(r"^CREATE\s+(UNIQUE\s+)?INDEX", re.IGNORECASE)
_INDEX_TARGET_RE = re.compile(r"\bON\s+(\w+)", re.IGNORECASE)


def _create_tables_and_indexes(
    con: sqlite3.Connection, schema_sql: str, existing_before: set[str]
) -> list[str]:
    """Create every table and index schema.sql declares, tolerating a
    CREATE INDEX that fails because it references a column this migration
    had to skip (see _is_safe_to_add) on a table that already existed.
    Table creation is never allowed to fail silently — only an index
    statement's failure is swallowed, and only after the table it targets
    is confirmed to already exist (so the failure really is "missing
    column", not "missing table").

    @returns indexes that could not be created, for the caller to log
    """
    skipped_indexes: list[str] = []
    for stmt in _split_statements(schema_sql):
        # A statement chunk may start with the section-header comment above
        # it (e.g. "-- ==== calls ====\nCREATE TABLE ...") — strip comment
        # and blank lines before checking the leading keyword, but execute
        # the original text; SQLite is fine with comments in DDL.
        body = _strip_comments(stmt).strip()
        if not _CREATE_TABLE_OR_INDEX_RE.match(body):
            continue
        if not _CREATE_INDEX_RE.match(body):
            con.execute(stmt)
            continue
        target = _INDEX_TARGET_RE.search(stmt)
        targets_preexisting_table = bool(target) and target.group(1) in existing_before
        if not targets_preexisting_table:
            con.execute(stmt)  # a fresh table from this same migration — always safe
            continue
        try:
            con.execute(stmt)
        except sqlite3.OperationalError as exc:
            skipped_indexes.append(f"{stmt} ({exc})")
    return skipped_indexes


def _existing_tables(con: sqlite3.Connection) -> set[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {r[0] for r in rows}


def check_and_migrate(con: sqlite3.Connection, schema_sql: str, db_label: str) -> dict:
    """Decide current / migratable / incompatible for `con` and apply the
    migration in place. Never executes a single statement before every
    compatibility check has passed — an incompatible database is refused
    (IncompatibleDatabaseError) with nothing written.

    @returns {"verdict": "created"|"current"|"migrated", "version": int,
              "added": [...], "skipped": [...]}  (added/skipped only when migrated)
    """
    target_version = parse_schema_version(schema_sql)
    renames = parse_renames(schema_sql)
    declared_tables = parse_table_columns(schema_sql)

    existing = _existing_tables(con)

    if not existing:
        # A brand new file — nothing to migrate, nothing to lose.
        con.executescript(schema_sql)
        con.execute(f"PRAGMA user_version = {target_version}")
        return {"verdict": "created", "version": target_version}

    found_version = con.execute("PRAGMA user_version").fetchone()[0]

    problems: list[str] = []
    for table, old_name, _new_name in renames:
        if table not in existing:
            continue
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if old_name in cols:
            problems.append(
                f"{table}.{old_name} is a pre-rename column name — this database "
                f"predates the {table} rename"
            )

    for table in existing:
        declared = declared_tables.get(table)
        if not declared:
            continue
        pk_decl = next(
            (decl for name, decl in declared if name == "id" and "PRIMARY KEY" in decl.upper()),
            None,
        )
        if not pk_decl:
            continue
        want_type = pk_decl.split()[0]
        live = {r[1]: r[2] for r in con.execute(f"PRAGMA table_info({table})")}
        live_type = live.get("id")
        if live_type and live_type.upper() != want_type.upper():
            problems.append(f"{table}.id is {live_type}, schema requires {want_type}")

    if problems:
        raise IncompatibleDatabaseError(
            f"Refusing to open {db_label}: incompatible schema (found "
            f"user_version={found_version}, required={target_version}). "
            + "; ".join(problems)
            + ". Rebuild the database — ALTER TABLE cannot fix this — rather than "
            "opening it as-is."
        )

    if found_version > target_version:
        raise IncompatibleDatabaseError(
            f"Refusing to open {db_label}: found user_version={found_version}, but "
            f"this code only understands schema versions up to {target_version}. "
            "Upgrade before opening this database."
        )

    if found_version == target_version:
        return {"verdict": "current", "version": target_version}

    # Migratable: add any column an existing table is missing FIRST — before
    # creating any wholly-new table or index, because schema.sql may declare
    # an index on a column an old table doesn't have yet
    # (idx_meds_patient_name_start references medications.start_date), and
    # CREATE INDEX has no "IF NOT EXISTS the referenced column" escape
    # hatch. Every check above has already passed, so a missing column here
    # is a genuine addition, never a stranded rename.
    added: list[str] = []
    skipped: list[str] = []
    for table, cols in declared_tables.items():
        if table not in existing:
            continue  # wholly new table — executescript below creates it whole
        live_cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols:
            if name in live_cols:
                continue
            if not _is_safe_to_add(decl):
                skipped.append(f"{table}.{name}")
                continue
            con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
            added.append(f"{table}.{name}")
    # Now safe to create any wholly-new table and every index that only
    # references columns that were either already there or just added
    # above. An index on a column this migration had to skip
    # (_is_safe_to_add) cannot be created either — that failure is caught
    # and logged rather than aborting the whole migration.
    skipped_indexes = _create_tables_and_indexes(con, schema_sql, existing)
    con.execute(f"PRAGMA user_version = {target_version}")
    return {
        "verdict": "migrated",
        "version": target_version,
        "from": found_version,
        "added": added,
        "skipped": skipped,
        "skipped_indexes": skipped_indexes,
    }
