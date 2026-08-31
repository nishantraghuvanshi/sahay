"""Schema version parsing and the open-time verdict. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md

api/schema.sql is the single authority for the target schema: both the target
version number and the additive column list are read out of it rather than
hand-maintained here. That is what replaces the two independent, disagreeing
lists this task removes (sqlite.js's _ensureColumn calls and this module's
former _ADDED_COLUMNS).

The Node counterpart (agent/src/adapters/persistence/schema-version.js)
implements the same algorithm against the same file; there is no shared
runtime. Both parse schema.sql the same way, and — this is the part that is
actually enforced — both test suites assert against ONE shared table of
database shapes, api/fixtures/schema-verdict-cases.json. "Kept in step by the
tests on each side" is what the sibling pair (api/db_path.py and
agent/src/utils/db-path.js) claimed while drifting in opposite directions for
four review rounds, because neither suite ever ran the other's inputs.
"""
from __future__ import annotations

import re
import sqlite3

from api.db_path import redact_credentials

SCHEMA_VERSION_RE = re.compile(r"SCHEMA_VERSION\s*=\s*(\d+)")
RENAMES_RE = re.compile(r"RENAMES:\s*(.+)")
_TABLE_RE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);")
_COL_RE = re.compile(r"^(\w+)\s+([\s\S]+)$")


class IncompatibleDatabaseError(Exception):
    """Raised when an existing database cannot be safely opened."""


def _recovery_instruction(db_label: str) -> str:
    """The route back out of a refusal, named as an actual command.

    A refused database refuses on EVERY subsequent open, by design — that is
    what stops an incomplete migration becoming permanent and invisible.
    Before this, the messages said to "rebuild the database" and named
    nothing, so an operator hitting it at 3am had a database that refuses
    forever and no stated way back.

    There is no single supported rebuild command in this repo to point at:
    scripts/seed.py is still a stub, init(reset=True) in api/db.py has no CLI
    entry point, and agent/scripts/seed-medications.js only materialises rows
    — it never recreates a schema. What IS true, and is what this names, is
    that check_and_migrate takes its `created` branch on an absent or empty
    file and executes api/schema.sql whole, and api/main.py reaches that
    through db.init() on every startup.

    MOVE ASIDE, never delete. A refused database may be the only copy of a
    patient's medication schedule, and none of these refusals modified its
    rows. Refusing is recoverable; destroying is not.

    The label is rendered through redact_credentials because it is a
    configured path, and a configured path has been a connection string
    carrying a password more than once here. In the normal case it is an
    ordinary path and comes back byte-identical, so the command below is
    literally runnable; in the pathological case the operator gets
    `<redacted>` and cannot paste it, which is the correct trade.
    """
    safe = redact_credentials(db_label)
    return (
        "Recover without losing data: move the current file aside, then start the "
        "service, which creates a fresh schema at that path — "
        f'mv "{safe}" "{safe}.superseded" && uvicorn api.main:app. '
        "Keep the old file rather than deleting it: it may be the only copy of a "
        "medication schedule, and this refusal left its rows untouched."
    )


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


_TABLE_DECLARATION_RE = re.compile(r"CREATE TABLE IF NOT EXISTS \w+")


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

    # Minor fix, round 1: _TABLE_RE requires a closing "\n);" — a future
    # table whose closing "); " lands on the same line as its last column
    # (no newline before it) would silently vanish from this authority's
    # output instead of failing loudly, and every open of every database
    # would then treat that table as though schema.sql never declared it.
    # Count "CREATE TABLE IF NOT EXISTS" occurrences independently of the
    # paired regex and refuse to proceed on a mismatch, rather than
    # trusting the paired regex found everything it should have.
    declared_count = len(_TABLE_DECLARATION_RE.findall(schema_sql))
    if len(tables) != declared_count:
        raise RuntimeError(
            f"parse_table_columns found {len(tables)} table(s) but schema.sql declares "
            f"{declared_count} — a CREATE TABLE statement failed to parse (its closing "
            '");" may not be on its own line). Refusing to derive a partial column list '
            "from the single source of truth rather than silently dropping a table."
        )

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
        # `is not None`, not a truthy check: PRAGMA table_info reports an
        # untyped column (e.g. `id PRIMARY KEY` with no type keyword) as the
        # empty string, and Python's `if live_type` treats "" the same as
        # "column absent" — silently skipping the mismatch instead of
        # flagging it. An untyped id is not a TEXT id; this used to migrate
        # such a table instead of refusing it, disagreeing with the Node
        # implementation, which does catch it (fix round 1, finding 3).
        if live_type is not None and live_type.upper() != want_type.upper():
            type_label = live_type or "(untyped)"
            problems.append(f"{table}.id is {type_label}, schema requires {want_type}")

    if problems:
        raise IncompatibleDatabaseError(
            f"Refusing to open {redact_credentials(db_label)}: incompatible schema "
            f"(found user_version={found_version}, required={target_version}). "
            + "; ".join(problems)
            + ". ALTER TABLE cannot fix this. "
            + _recovery_instruction(db_label)
        )

    if found_version > target_version:
        raise IncompatibleDatabaseError(
            f"Refusing to open {redact_credentials(db_label)}: found "
            f"user_version={found_version}, but this code only understands schema "
            f"versions up to {target_version}. The remedy here is to upgrade this "
            "code, NOT to rebuild — the database is newer than the code, and its "
            f"rows are fine. Deploy a build that understands version {found_version}."
        )

    if found_version == target_version:
        return {"verdict": "current", "version": target_version}

    # Deviation from the brief, ruled on deliberately (fix round 1, finding
    # 4 — not an oversight): task-4-brief.md says "Version 0 (no marker,
    # pre-reconciliation) is incompatible." This code instead falls through
    # to the migratable branch below for a version-0 database whose SHAPE
    # is otherwise compatible (right PK types, no pre-rename column names)
    # — the rename/PK-type checks above already ran and would have refused
    # it if it actually were the pre-reconciliation shape. A strict reading
    # of the brief would refuse every database that predates this task
    # (there was no marker anywhere before it), including every currently-
    # working dev database, and would make the `migratable` verdict
    # unreachable at target=1 since there is no version 0.5 to migrate
    # from. Ruled that the behaviour stands: "version 0" in the brief means
    # the specific pre-reconciliation shape, which the shape checks already
    # catch by construction, not literally every database that has never
    # had a version stamped on it.
    #
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
    # (_is_safe_to_add) cannot be created either — that failure is caught,
    # not swallowed: see below.
    skipped_indexes = _create_tables_and_indexes(con, schema_sql, existing)

    # Fix round 1, finding 1: this used to stamp user_version unconditionally
    # here, regardless of `skipped`/`skipped_indexes` — so a migration that
    # knowingly could not add a column, or could not create an index that
    # depended on it (idx_meds_patient_name_start is UNIQUE — the exact
    # idempotency guarantee TRD §3.1 requires), still recorded the database
    # as fully current. Every later open then took the `current` branch
    # above and returned instantly: the gap became permanent and invisible,
    # which is precisely the failure this whole task exists to remove.
    #
    # Folded into the `incompatible` verdict rather than adding a fourth
    # one: the brief specifies three verdicts, and an unstamped, retried-
    # on-every-open refusal already delivers "visible on every subsequent
    # open" — no separate `incomplete` bookkeeping is needed for that. The
    # columns that WERE safely added above are left in place (they are
    # harmless additive changes on their own); only the version stamp —
    # the claim "this database is fully current" — is withheld. A future
    # open of this same database re-runs this exact code path (found_
    # version is still behind target, tables still exist), gets the same
    # added/skipped verdict again deterministically, and raises again —
    # that is what makes it visible on every open rather than once, not a
    # stored "incomplete" flag.
    if skipped or skipped_indexes:
        raise IncompatibleDatabaseError(
            f"Refusing to certify {redact_credentials(db_label)} as migrated to "
            f"version {target_version} (found user_version={found_version}): the "
            f"migration could not complete safely. {len(skipped)} column(s) could not "
            f"be added — {', '.join(skipped) or 'none'} — {len(skipped_indexes)} index "
            "statement(s) could not run as a result. SQLite cannot ALTER TABLE ADD "
            "COLUMN a NOT NULL column with no DEFAULT, or any column whose DEFAULT is "
            "not a constant, onto a table that already has rows. user_version was left "
            "unchanged so this refusal repeats on every open — do not treat this as "
            "transient. " + _recovery_instruction(db_label)
        )

    con.execute(f"PRAGMA user_version = {target_version}")
    return {
        "verdict": "migrated",
        "version": target_version,
        "from": found_version,
        "added": added,
        "skipped": skipped,
        "skipped_indexes": skipped_indexes,
    }
