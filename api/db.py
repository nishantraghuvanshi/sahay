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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCHEMA = ROOT / "schema.sql"

# The fixture Lane C built every screen against. Seeding from it means the live
# endpoints return exactly the shapes the app already renders, so switching the
# app from mock to live is a base-URL change and not a debugging session.
FIXTURE = ROOT.parent / "scripts" / "mock-api.json"

DB_PATH = Path(os.getenv("KINVOX_DB", ROOT / "kinvox.db"))

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


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


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


def insert(con: sqlite3.Connection, table: str, row: dict) -> None:
    data = _encode(table, row)
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    con.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({marks})", tuple(data.values()))


def decode(table: str, row: sqlite3.Row) -> dict:
    """Row -> dict with JSON columns parsed back and booleans restored."""
    out = dict(row)
    for col in JSON_COLUMNS.get(table, ()):
        if col in out and isinstance(out[col], str):
            try:
                out[col] = json.loads(out[col])
            except json.JSONDecodeError:
                out[col] = None
    return out


# Columns added after a database may already exist. `CREATE TABLE IF NOT EXISTS`
# silently skips an existing table, so a new column would never appear and every
# query naming it would fail on a developer's older file. Each entry must be
# nullable or carry a DEFAULT — SQLite cannot add a bare NOT NULL column to a table
# that already has rows.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "medications": {
        "stopped_at": "TEXT",
        "start_date": "TEXT",
    },
    "dose_events": {
        "rescheduled_to": "TEXT",
        "attempt_count": "INTEGER NOT NULL DEFAULT 0",
        "next_attempt_at": "TEXT",
        "actor": "TEXT",
    },
    "escalations": {
        "dose_event_id": "TEXT",
    },
    "patients": {
        "timezone": "TEXT NOT NULL DEFAULT 'Asia/Kolkata'",
        "quiet_windows": "TEXT",
        "drug_name": "TEXT",
        "notes": "TEXT",
        "updated_at": "TEXT",
    },
}
_ADDED_COLUMNS["calls"] = {"alert_sent_at": "TEXT", "alert_channel": "TEXT"}
_ADDED_COLUMNS["medications"].update({"created_at": "TEXT", "updated_at": "TEXT"})
_ADDED_COLUMNS["dose_events"]["call_id"] = "TEXT"
_ADDED_COLUMNS["dose_events"].update(
    {"confirmed_at": "TEXT", "updated_at": "TEXT"}
)


def _migrate(con: sqlite3.Connection) -> list[str]:
    """Add columns an older database is missing. Returns what it added."""
    added = []
    for table, columns in _ADDED_COLUMNS.items():
        existing = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # table not created yet; the schema script will make it whole
        for name, decl in columns.items():
            if name not in existing:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                added.append(f"{table}.{name}")
    return added


def init(reset: bool = False) -> None:
    """Create the schema, and seed it the first time.

    Seeding only happens when `caregivers` is empty, so restarting the API never
    overwrites a schedule someone signed off through the app.
    """
    if reset and DB_PATH.exists():
        DB_PATH.unlink()

    con = connect()
    try:
        con.executescript(SCHEMA.read_text())
        added = _migrate(con)
        if added:
            import logging
            logging.getLogger("kinvox.api").info("migrated: added %s", ", ".join(added))
        already = con.execute("SELECT COUNT(*) FROM caregivers").fetchone()[0]
        if not already:
            _seed(con)
        con.commit()
    finally:
        con.close()


def _seed(con: sqlite3.Connection) -> None:
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
