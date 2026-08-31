"""SQLite connection, schema init, and seeding. spec: TRD §3, §3.2

SQLite so the API runs from a fresh clone with nothing to provision. The schema in
schema.sql keeps TRD §3's column names and nullability, so moving to Postgres later
is a type substitution rather than a redesign.

Timestamps are stored as ISO-8601 UTC strings with an explicit offset. Dates that
matter to a caregiver — a 21:00 IST dose — are LOCAL times in `medications.slots`
and are only combined with a date at read time, never stored pre-combined, which is
what stops a dose drifting a day when the server and the phone disagree about zones.
"""
import json
import os
import sqlite3
from collections.abc import Mapping
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from api import schema_version
from api.db_path import assert_database_target

ROOT = Path(__file__).resolve().parent
SCHEMA = ROOT / "schema.sql"

# The fixture Lane C built every screen against. Seeding from it means the live
# endpoints return exactly the shapes the app already renders, so switching the
# app from mock to live is a base-URL change and not a debugging session.
FIXTURE = ROOT.parent / "scripts" / "mock-api.json"

_DB_PATH_ENV = "VOXIKIN_DB"
DB_PATH = Path(os.getenv(_DB_PATH_ENV, ROOT / "voxikin.db"))

# Turso (libSQL) when the URL is set, local SQLite file otherwise.
#
# Deployment moved this database off the API's own disk: the free tiers that run
# this service cannot attach a persistent one, so a local file is erased on every
# redeploy — and the voice agent, which shares this database and nothing else,
# would be reading a different copy anyway.
#
# Local stays on stdlib sqlite3 rather than pointing libsql at a file. It keeps a
# fresh clone working with nothing to provision, and it keeps the test suite on
# the driver it was written against.
TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()


def is_remote() -> bool:
    return bool(TURSO_DATABASE_URL)


# The fixture is written against this date; every timestamp in it is shifted by
# whole days onto today, so "yesterday" stays yesterday however long the file sits
# in git. Mirrors the same rebasing in app/src/api/mock.ts.
FIXTURE_ANCHOR = "2026-08-30"

JSON_COLUMNS = {
    "patients": ("conditions", "allergies", "meal_times", "consents"),
    "medications": ("slots", "extraction_flags"),
    "intake_records": ("fields",),
    "escalations": ("payload",),
    "call_sessions": ("safety_findings",),
    "medication_changes": ("diff",),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────────
# libSQL row compatibility.
#
# The libsql driver (0.1.11) returns plain tuples and its Connection is a
# builtins type with no __dict__, so `con.row_factory = sqlite3.Row` raises
# AttributeError rather than being ignored. Every read in this API does
# `row["column"]` or `dict(row)` — db.decode(), _migrate()'s PRAGMA walk, and
# ~40 call sites in the route modules — so without this the port is a rewrite of
# all of them instead of a change to connect().
#
# cursor.description survives, which is all a row wrapper needs.


class Row(Mapping):
    """A sqlite3.Row work-alike: row["col"], row[0], dict(row), .keys()."""

    __slots__ = ("_cols", "_vals", "_idx")

    def __init__(self, cols: tuple[str, ...], vals: tuple):
        self._cols = cols
        self._vals = vals
        self._idx = {c: i for i, c in enumerate(cols)}

    def __getitem__(self, key):
        if isinstance(key, str):
            try:
                return self._vals[self._idx[key]]
            except KeyError:
                # sqlite3.Row raises IndexError, not KeyError, for a bad column.
                raise IndexError(f"No item with that key: {key!r}") from None
        return self._vals[key]

    def keys(self) -> list[str]:
        return list(self._cols)

    def __iter__(self):
        # Mapping iterates keys. sqlite3.Row iterates values, but nothing here
        # relies on that, and keys-iteration is what keeps dict(row) correct.
        return iter(self._cols)

    def __len__(self) -> int:
        return len(self._cols)

    def __repr__(self) -> str:
        return f"<Row {dict(self)!r}>"


class _LibsqlCursor:
    """Wraps a libsql cursor so its rows come back as Row."""

    def __init__(self, cur):
        self._cur = cur
        self._cols = tuple(d[0] for d in (cur.description or ()))

    def _wrap(self, row):
        return None if row is None else Row(self._cols, row)

    def fetchone(self):
        return self._wrap(self._cur.fetchone())

    def fetchall(self) -> list[Row]:
        return [self._wrap(r) for r in self._cur.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())

    def __getattr__(self, name):
        return getattr(self._cur, name)


class _LibsqlConnection:
    """The slice of the sqlite3 connection API this module uses."""

    def __init__(self, con):
        self._con = con

    def execute(self, sql: str, params=()) -> _LibsqlCursor:
        # libsql wants a tuple; _Conn._q hands us a list.
        return _LibsqlCursor(self._con.execute(sql, tuple(params)))

    def executescript(self, script: str):
        return self._con.executescript(script)

    def __getattr__(self, name):
        return getattr(self._con, name)


def connect():
    """A connection to Turso if configured, else the local SQLite file."""
    if is_remote():
        import libsql

        # auth_token has to be omitted rather than passed as None: the driver
        # types it as a string and rejects None outright. A local file path is a
        # valid URL here and needs no token, which is how the tests reach this
        # branch without a Turso account.
        opts = {"auth_token": TURSO_AUTH_TOKEN} if TURSO_AUTH_TOKEN else {}
        con = _LibsqlConnection(libsql.connect(TURSO_DATABASE_URL, **opts))
    else:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row

    # Foreign keys are per-connection in SQLite and must be re-armed every time.
    # _CASCADE_PARENTS below depends on knowing whether this took effect.
    con.execute("PRAGMA foreign_keys = ON")
    return con


# ─────────────────────────────────────────────────────────────────────────
# asyncpg-shaped adapter.
#
# The caregiver-auth modules (api/auth, api/caregiver) arrived from the app lane
# written against an asyncpg pool: `async with db.connection() as conn`, then
# `await conn.fetchrow("... WHERE id = $1", x)`. This API runs on SQLite.
#
# Rewriting all 68 of their placeholders by hand would work once and then fight
# every future merge from that lane. Adapting the small surface they actually
# use is less code, and it keeps their files close enough to upstream that the
# next merge is a merge rather than a re-port.
#
# What this does NOT paper over: Postgres-only SQL. `now()` and
# `::interval` arithmetic have no SQLite equivalent that compares correctly
# against our ISO-8601 text timestamps, so those statements were ported to bind
# Python-computed values instead. sqlite3's `datetime('now')` renders
# "YYYY-MM-DD HH:MM:SS" while everything else here is
# "YYYY-MM-DDTHH:MM:SS+00:00" — string comparison between the two silently
# yields the wrong answer, which is the kind of bug that only shows up when a
# session refuses to expire.


class _Conn:
    """The slice of asyncpg's connection API the auth modules use."""

    def __init__(self, con, in_transaction: bool = False):
        self._con = con
        # Inside `db.transaction()` the block decides when to commit. Committing
        # per statement made the rollback on the way out a no-op, so a failure
        # half way through onboarding left a patient with half a prescription —
        # exactly what that route's docstring says the transaction prevents.
        self._in_transaction = in_transaction

    @staticmethod
    def _q(sql: str, args: tuple) -> tuple[str, list]:
        """`$1, $2 …` -> `?`, with the arguments reordered to match.

        Not a plain substitution. asyncpg lets one placeholder appear twice —
        `WHERE phone_e164 = $1 OR lower(email) = lower($1)` is real code in the
        login route — and SQLite's `?` is strictly positional, so a naive
        replace produces two placeholders for one argument and sqlite3 raises
        "Incorrect number of bindings supplied". Walking the occurrences in
        order and emitting args[n-1] each time keeps repeats working.
        """
        import re

        params: list = []

        def sub(m: "re.Match[str]") -> str:
            idx = int(m.group(0)[1:]) - 1
            params.append(args[idx] if idx < len(args) else None)
            return "?"

        return re.sub(r"\$\d+", sub, sql), params

    async def fetchrow(self, sql: str, *args):
        q, p = self._q(sql, args)
        return self._con.execute(q, p).fetchone()

    async def fetch(self, sql: str, *args):
        q, p = self._q(sql, args)
        return self._con.execute(q, p).fetchall()

    async def fetchval(self, sql: str, *args):
        q, p = self._q(sql, args)
        row = self._con.execute(q, p).fetchone()
        return row[0] if row else None

    async def execute(self, sql: str, *args):
        q, p = self._q(sql, args)
        self._con.execute(q, p)
        if not self._in_transaction:
            self._con.commit()


class _ConnCtx:
    """`async with db.connection() as conn:` over a sqlite3 connection.

    One connection per request rather than a pool: sqlite3 connections are
    cheap, and sharing one across async handlers would need a lock to be safe.
    """

    IN_TRANSACTION = False

    async def __aenter__(self) -> _Conn:
        self._con = connect()
        return _Conn(self._con, self.IN_TRANSACTION)

    async def __aexit__(self, *exc):
        self._con.close()
        return False


class _TxCtx(_ConnCtx):
    """`async with db.transaction() as conn:` — commits on clean exit, rolls
    back on exception. sqlite3 opens a transaction implicitly on the first
    write, so this only has to decide how it ends."""

    IN_TRANSACTION = True

    async def __aexit__(self, exc_type, *rest):
        try:
            if exc_type is None:
                self._con.commit()
            else:
                self._con.rollback()
        finally:
            self._con.close()
        return False


def connection() -> _ConnCtx:
    return _ConnCtx()


def transaction() -> _TxCtx:
    return _TxCtx()


async def open_pool() -> None:
    """No-op. Kept so the lifespan wiring that came with the auth lane still
    reads the same; SQLite has nothing to open ahead of time."""
    return None


async def close_pool() -> None:
    return None


def _day_shift() -> int:
    """Whole days between the fixture's anchor date and today, in LOCAL time.

    Local, not UTC, and compared as dates rather than instants. At 03:00 IST the
    UTC date is still yesterday, so a UTC comparison shifts the whole fixture back
    a day — and app/src/api/mock.ts rebases against local midnight, so the mock and
    the live API would disagree about which day a dose belongs to.
    """
    return (datetime.now().astimezone().date() - date.fromisoformat(FIXTURE_ANCHOR)).days


def _rebase(value, shift: int):
    """Shift every ISO timestamp in the fixture by whole days onto today."""
    if isinstance(value, str):
        try:
            if len(value) >= 11 and value[10] == "T":
                return (datetime.fromisoformat(value) + timedelta(days=shift)).isoformat()
        except ValueError:
            pass
        return value
    if isinstance(value, list):
        return [_rebase(v, shift) for v in value]
    if isinstance(value, dict):
        return {k: _rebase(v, shift) for k, v in value.items()}
    return value


def _encode(table: str, row: dict) -> dict:
    """JSON-encode the columns SQLite cannot hold natively."""
    out = dict(row)
    for col in JSON_COLUMNS.get(table, ()):
        if col in out and not isinstance(out[col], (str, type(None))):
            out[col] = json.dumps(out[col])
    for col, value in list(out.items()):
        if isinstance(value, bool):
            out[col] = int(value)
    return out


# Tables a REPLACE must never touch, because another table cascades off them.
#
# SQLite implements INSERT OR REPLACE as DELETE followed by INSERT, and with
# foreign keys on, that DELETE fires ON DELETE CASCADE. Rewriting a caregiver
# row therefore destroyed every auth_sessions row pointing at it: finishing
# onboarding silently signed the caregiver out, and the next screen answered
# 401. The caregiver row looked untouched afterwards — same id, updated name —
# which is why this was invisible until an end-to-end test walked the journey.
#
# The auth tables arrived with the origin/main merge; INSERT OR REPLACE predates
# them, and nothing connected the two.
_CASCADE_PARENTS = {"caregivers", "patients"}


def insert(con, table: str, row: dict) -> None:
    data = _encode(table, row)
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)

    if table in _CASCADE_PARENTS:
        # Upsert in place: same effect on this row, without deleting it first.
        assignments = ", ".join(f"{c} = excluded.{c}" for c in data if c != "id")
        con.execute(
            f"INSERT INTO {table} ({cols}) VALUES ({marks}) "
            f"ON CONFLICT(id) DO UPDATE SET {assignments}",
            tuple(data.values()),
        )
        return

    con.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({marks})", tuple(data.values()))


def decode(table: str, row) -> dict:
    """Row -> dict with JSON columns parsed back and booleans restored."""
    out = dict(row)
    for col in JSON_COLUMNS.get(table, ()):
        if col in out and isinstance(out[col], str):
            try:
                out[col] = json.loads(out[col])
            except json.JSONDecodeError:
                out[col] = None
    return out


# Schema-version check and additive migration. api/schema.sql is the single
# authority for both the target version and the column list — see
# schema_version.py — replacing what used to be a hand-maintained dict here
# that had drifted out of step with agent/src/adapters/persistence/sqlite.js's
# own hand-maintained list of the same thing. spec:
# .superpowers/sdd/modularise-boundaries/task-4-brief.md
def _migrate(con: sqlite3.Connection) -> list[str]:
    """Add columns an existing, compatible database is missing. Returns what
    it added. Kept as a thin wrapper (same name and return shape as before)
    over schema_version.check_and_migrate so existing direct callers of this
    function don't need to change. Raises
    schema_version.IncompatibleDatabaseError, and adds nothing, when the
    database predates a rename or has the wrong primary-key type.
    """
    result = schema_version.check_and_migrate(con, SCHEMA.read_text(), str(DB_PATH))
    return result.get("added", [])


def seed_enabled() -> bool:
    """Whether the demo household may be written into an empty database.

    Opt-in, and default off. The seed is a whole fabricated family — Shubh, his
    mother, her three medicines and a week of calls — and while the app read from
    a client-side mock it was harmless scaffolding. Now that every screen reads
    the real API, a deployment that seeds itself hands the first real caregiver a
    patient who does not exist. Reads are caregiver-scoped, so they would not in
    fact see it, but the row is still there to be joined to by anything that
    forgets, and "there is a fake patient in the health record" is not a state to
    leave switched on by default.

    Set VOXIKIN_SEED=1 for the demo and the fixtures the tests build against.
    """
    return os.getenv("VOXIKIN_SEED", "").strip().lower() in {"1", "true", "yes"}


def migrate_on_boot() -> bool:
    """Whether startup should apply schema.sql itself.

    On a local file this is what makes a fresh clone work with nothing to
    provision, so it stays on by default. Against Turso it is 430 statements over
    the network on every boot, from two services that can race each other, so the
    schema is applied once out of band instead:

        turso db shell <db> < api/schema.sql

    Set VOXIKIN_MIGRATE_ON_BOOT=1 to force it on anyway — useful the first time a
    remote database is created, and for a throwaway staging one.
    """
    override = os.getenv("VOXIKIN_MIGRATE_ON_BOOT", "").strip().lower()
    if override in {"1", "true", "yes"}:
        return True
    if override in {"0", "false", "no"}:
        return False
    return not is_remote()


def init(reset: bool = False) -> None:
    """Create the schema, and seed it the first time, if seeding is switched on.

    Seeding only happens when `caregivers` is empty, so restarting the API never
    overwrites a schedule someone signed off through the app.

    Fails closed: a configured path that is evidently not a filesystem path
    (a Postgres/MySQL/etc connection string — see agent/postgresql:/... in
    this working tree) is refused before anything is created OR DESTROYED.

    Beyond that, what "refused" means depends on WHICH refusal fires, and the
    two are not the same guarantee:

      - A pre-rename column name, a mismatched primary-key type, or a
        user_version from the future is refused with NOTHING WRITTEN. Those
        checks all run before the first statement is executed, so the file on
        disk is left byte-identical. (This used to run the full schema script
        unconditionally before that check, which would have created any
        wholly-new table on an incompatible database — CREATE TABLE IF NOT
        EXISTS is a no-op only for tables that already exist — before refusal
        had a chance to run.)
      - An incomplete migration (a column SQLite cannot safely ALTER in, or
        an index that depended on one) is refused AFTER the schema script has
        run: columns that could be added safely have been added, and any
        wholly-new table and index has been created. Only PRAGMA
        user_version is withheld, so the refusal repeats deterministically on
        every subsequent open instead of the gap becoming permanent and
        invisible.

    This docstring used to say an incompatible database is "refused with
    nothing written" without qualification — true before the
    incomplete-migration refusal existed, false after it. See
    schema_version.check_and_migrate for the verdict logic.

    Fix round 1, finding 2: assert_database_target used to run AFTER
    `reset and DB_PATH.exists(): DB_PATH.unlink()` — so `init(reset=True)`
    with a URL-shaped VOXIKIN_DB deleted the file before refusing.
    Deletion is not creation; the guard has to come first, unconditionally,
    before reset has a chance to touch anything.
    """
    assert_database_target(str(DB_PATH), _DB_PATH_ENV if _DB_PATH_ENV in os.environ else None)

    if reset:
        if is_remote():
            # Deleting a shared remote database is not this function's call to
            # make, and `reset` is only ever passed by tests against a local file.
            raise RuntimeError("init(reset=True) refuses to drop a remote database")
        if DB_PATH.exists():
            DB_PATH.unlink()

    con = connect()
    try:
        # Seeding is checked either way: whether the schema was applied here or
        # out of band, an empty database still wants its demo household when the
        # demo asks for one.
        if migrate_on_boot():
            result = schema_version.check_and_migrate(con, SCHEMA.read_text(), str(DB_PATH))
            added = result.get("added", [])
            if added:
                import logging
                logging.getLogger("voxikin.api").info("migrated: added %s", ", ".join(added))
        already = con.execute("SELECT COUNT(*) FROM caregivers").fetchone()[0]
        if not already and seed_enabled():
            _seed(con)
        con.commit()
    finally:
        con.close()


def _seed(con) -> None:
    """TRD §3.2 — the seed everyone else builds against, taken from the fixture."""
    shift = _day_shift()
    data = _rebase(json.loads(FIXTURE.read_text()), shift)

    caregiver = data["caregiver"]
    patient = dict(data["patient"])

    insert(con, "caregivers", caregiver)

    # The seed patient's schedule is already signed off, and the fixture predates
    # the consent gate, so the intro call is recorded as done. A patient whose
    # intro call is still pending must not have dose reminders dialled (GAP-2).
    patient.setdefault("intro_call_at", None)
    patient.setdefault("intro_call_status", "done")
    patient.setdefault("consents", None)
    insert(con, "patients", patient)

    confirmed_at = patient.get("schedule_signed_off_at") or now_iso()
    for med in data["medications"]:
        insert(con, "medications", {
            **med,
            # Seeded rows were typed by a person, not read off a photograph.
            "source": "manual",
            "confirmed_by": caregiver["id"],
            "confirmed_at": confirmed_at,
        })

    for table in ("call_sessions", "dose_events", "observations", "intake_records",
                  "escalations", "handoffs"):
        for row in data.get(table, []):
            insert(con, table, row)
