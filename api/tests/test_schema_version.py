"""schema_version.py — the three open-time verdicts. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md

Pure sqlite3 + pathlib, no FastAPI dependency, so this file only needs pytest
itself to run (neither pytest nor fastapi were installed in the environment
this was written in — see task-4-report.md for what was verified by running
the bodies below directly with plain asserts instead).
"""
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api import schema_version  # noqa: E402

SCHEMA_SQL = (Path(__file__).resolve().parents[1] / "schema.sql").read_text()

PRE_RECONCILIATION_DB = (
    Path(__file__).resolve().parents[2]
    / "agent"
    / "data"
    / "voiceagent.db.pre-reconciliation-1300"
)


def _open(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con


class TestParsing:
    def test_parse_schema_version_reads_the_marker(self):
        assert schema_version.parse_schema_version(SCHEMA_SQL) == 1

    def test_parse_schema_version_without_a_marker_raises(self):
        with pytest.raises(RuntimeError, match="SCHEMA_VERSION"):
            schema_version.parse_schema_version("-- no marker here")

    def test_parse_renames_reads_the_documented_medications_renames(self):
        assert schema_version.parse_renames(SCHEMA_SQL) == [
            ("medications", "times", "slots"),
            ("medications", "food_rule", "with_food"),
        ]

    def test_parse_table_columns_finds_all_18_tables(self):
        tables = schema_version.parse_table_columns(SCHEMA_SQL)
        assert len(tables) == 18
        med_cols = [name for name, _decl in tables["medications"]]
        assert "slots" in med_cols
        assert "with_food" in med_cols
        assert "times" not in med_cols

    def test_a_check_constraint_with_a_comma_stays_one_column(self):
        tables = schema_version.parse_table_columns(SCHEMA_SQL)
        otp_cols = [name for name, _decl in tables["auth_otp"]]
        assert otp_cols == [
            "id", "channel", "destination", "code_hash", "expires_at",
            "attempts", "consumed_at", "request_ip", "created_at",
        ]


class TestVerdictCurrent:
    def test_a_brand_new_file_gets_the_full_schema_and_target_version(self, tmp_path):
        con = _open(tmp_path / "fresh.db")
        result = schema_version.check_and_migrate(con, SCHEMA_SQL, "fresh.db")
        assert result["verdict"] == "created"
        assert result["version"] == 1
        assert con.execute("PRAGMA user_version").fetchone()[0] == 1
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "patients" in tables
        assert "payments" in tables
        con.close()

    def test_opening_an_already_current_database_again_is_a_no_op(self, tmp_path):
        con = _open(tmp_path / "current.db")
        schema_version.check_and_migrate(con, SCHEMA_SQL, "current.db")
        second = schema_version.check_and_migrate(con, SCHEMA_SQL, "current.db")
        assert second["verdict"] == "current"
        con.close()


class TestVerdictMigratable:
    def test_a_compatible_database_missing_gap_columns_gets_them_added(self, tmp_path):
        # TEXT id, current column names, stripped to only the columns that
        # existed before the caregiver-app gap columns were added — every
        # one of those gap columns is nullable or DEFAULT-constant. A
        # `medications` table deliberately isn't part of this fixture: its
        # missing gap columns include NOT-NULL-no-DEFAULT and non-constant-
        # DEFAULT ones, which is the separate, now-refusing case in
        # TestVerdictIncompatible below (fix round 1, finding 1).
        con = _open(tmp_path / "old.db")
        con.executescript(
            "CREATE TABLE patients (id TEXT PRIMARY KEY, phone_e164 TEXT NOT NULL UNIQUE, "
            "created_at TEXT NOT NULL);"
        )
        result = schema_version.check_and_migrate(con, SCHEMA_SQL, "old.db")
        assert result["verdict"] == "migrated"
        assert result["from"] == 0
        assert result["version"] == 1
        assert "patients.timezone" in result["added"]
        assert "patients.caregiver_id" in result["added"]
        assert result["skipped"] == []
        assert result["skipped_indexes"] == []
        assert con.execute("PRAGMA user_version").fetchone()[0] == 1
        con.close()


class TestVerdictIncompatible:
    # Fix round 1, finding 1: this used to be "never adds a NOT NULL column
    # with no DEFAULT — it is skipped, not thrown", asserting a `migrated`
    # verdict with `skipped` columns AND user_version stamped anyway. That
    # stamped the database as fully current despite a stranded UNIQUE index
    # gap (idx_meds_patient_name_start needs start_date, which cannot be
    # safely ALTERed) — every later open then took the fast `current` path
    # and the gap became permanent and invisible. Fixed to refuse instead,
    # and to refuse identically on every subsequent open.
    def test_a_column_sqlite_cannot_safely_alter_in_is_refused_not_silently_certified(self, tmp_path):
        con = _open(tmp_path / "stripped.db")
        con.executescript(
            "CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);"
            "CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);"
            "INSERT INTO medications (id, name) VALUES ('m1', 'Metformin');"
        )

        with pytest.raises(schema_version.IncompatibleDatabaseError):
            schema_version.check_and_migrate(con, SCHEMA_SQL, "stripped.db")
        # user_version must NOT be stamped — this is the whole point of the fix.
        assert con.execute("PRAGMA user_version").fetchone()[0] == 0
        row = con.execute("SELECT name FROM medications WHERE id = 'm1'").fetchone()
        assert row["name"] == "Metformin"

        # Visible on EVERY subsequent open, not once.
        with pytest.raises(schema_version.IncompatibleDatabaseError):
            schema_version.check_and_migrate(con, SCHEMA_SQL, "stripped.db")
        assert con.execute("PRAGMA user_version").fetchone()[0] == 0
        con.close()

    def test_the_refusal_message_names_which_columns_could_not_complete(self, tmp_path):
        con = _open(tmp_path / "stripped-message.db")
        con.executescript(
            "CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);"
            "CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);"
        )
        with pytest.raises(schema_version.IncompatibleDatabaseError) as exc_info:
            schema_version.check_and_migrate(con, SCHEMA_SQL, "stripped-message.db")
        message = str(exc_info.value)
        assert "medications.patient_id" in message
        assert "medications.dose" in message
        assert "index statement(s) could not run" in message
        con.close()

    def test_integer_primary_key_where_schema_says_text_is_refused(self, tmp_path):
        con = _open(tmp_path / "intpk.db")
        con.executescript(
            "CREATE TABLE patients (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "phone_e164 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);"
        )
        with pytest.raises(schema_version.IncompatibleDatabaseError):
            schema_version.check_and_migrate(con, SCHEMA_SQL, "intpk.db")
        # nothing written
        assert con.execute("PRAGMA user_version").fetchone()[0] == 0
        cols = [r[1] for r in con.execute("PRAGMA table_info(patients)")]
        assert cols == ["id", "phone_e164", "created_at"]
        con.close()

    def test_an_untyped_id_column_is_refused_too_not_just_a_mismatched_type_one(self, tmp_path):
        """Fix round 1, finding 3: `if live_type and ...` treated an untyped
        id column (PRAGMA table_info reports its type as "") the same as
        "column absent", silently skipping the mismatch — Node already
        caught this case, so the two runtimes disagreed. An untyped id is
        not a TEXT id."""
        con = _open(tmp_path / "untyped-pk.db")
        con.executescript(
            "CREATE TABLE patients (id PRIMARY KEY, "
            "phone_e164 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);"
        )
        with pytest.raises(
            schema_version.IncompatibleDatabaseError,
            match=r"patients\.id is \(untyped\), schema requires TEXT",
        ):
            schema_version.check_and_migrate(con, SCHEMA_SQL, "untyped-pk.db")
        assert con.execute("PRAGMA user_version").fetchone()[0] == 0
        con.close()

    def test_a_pre_rename_column_is_refused_never_auto_added_beside_slots(self, tmp_path):
        con = _open(tmp_path / "renamed.db")
        con.executescript(
            "CREATE TABLE medications (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, "
            "name TEXT NOT NULL, dose TEXT NOT NULL, "
            "times TEXT NOT NULL DEFAULT '[]', food_rule TEXT);"
            "INSERT INTO medications (id, patient_id, name, dose, times) "
            "VALUES ('m1','p1','Metformin','500mg','[\"08:00\"]');"
        )
        with pytest.raises(schema_version.IncompatibleDatabaseError, match="medications.times"):
            schema_version.check_and_migrate(con, SCHEMA_SQL, "renamed.db")
        cols = [r[1] for r in con.execute("PRAGMA table_info(medications)")]
        assert "slots" not in cols
        row = con.execute("SELECT times FROM medications WHERE id = 'm1'").fetchone()
        assert row["times"] == '["08:00"]'
        con.close()

    def test_a_future_user_version_this_code_does_not_understand_is_refused(self, tmp_path):
        con = _open(tmp_path / "future.db")
        con.executescript(SCHEMA_SQL)
        con.execute("PRAGMA user_version = 999")
        with pytest.raises(schema_version.IncompatibleDatabaseError):
            schema_version.check_and_migrate(con, SCHEMA_SQL, "future.db")
        con.close()

    @pytest.mark.skipif(
        not PRE_RECONCILIATION_DB.exists(),
        reason="evidence file only present on the machine this task was done on",
    )
    def test_the_real_pre_reconciliation_database_is_refused_original_untouched(self, tmp_path):
        before = PRE_RECONCILIATION_DB.read_bytes()

        copy_path = tmp_path / "pre-recon-copy.db"
        shutil.copy(PRE_RECONCILIATION_DB, copy_path)
        con = _open(copy_path)

        with pytest.raises(schema_version.IncompatibleDatabaseError) as exc_info:
            schema_version.check_and_migrate(con, SCHEMA_SQL, str(copy_path))
        message = str(exc_info.value)
        assert "user_version=0" in message
        assert "required=1" in message
        assert "medications.times" in message
        assert "medications.id is INTEGER" in message
        con.close()

        # the original evidence file was never opened by this test — only the copy was
        assert PRE_RECONCILIATION_DB.read_bytes() == before


VERDICT_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "schema-verdict-cases.json").read_text()
)
VERDICT_CASES = VERDICT_FIXTURE["cases"]


def _apply_verdict_case(con, case):
    if case["setup_sql"]:
        con.executescript(case["setup_sql"])
    if case["pre_migrate"]:
        schema_version.check_and_migrate(con, SCHEMA_SQL, "pre-migrate")
    if case["user_version"] is not None:
        con.executescript(f"PRAGMA user_version = {case['user_version']}")


def _table_columns(con, table):
    return [r[1] for r in con.execute(f"PRAGMA table_info({table})")]


class TestVerdictParityAgainstTheSharedFixture:
    """api/fixtures/schema-verdict-cases.json lists database shape -> expected
    verdict, and agent/tests/schema-version.test.js runs the SAME table against
    agent/src/adapters/persistence/schema-version.js.

    This exists because the sibling pair of this module (api/db_path.py and
    agent/src/utils/db-path.js) was also "kept in step by the tests on each
    side" — and drifted for four review rounds, in opposite directions,
    because neither suite ever ran the other's inputs. A comment claiming
    parity is not enforcement; a file both sides read is. Add a shape to the
    fixture, not to one suite.

    The bespoke tests above stay: they assert runtime-specific things the
    fixture deliberately cannot carry (row survival through a refusal, the
    repeat-refusal on every open, and the real pre-reconciliation evidence
    file on disk).
    """

    def test_the_fixture_is_present_and_non_trivial(self):
        # An empty or missing fixture must not read as a pass.
        assert len(VERDICT_CASES) == 8, "expected the 8 documented shapes"
        verdicts = {c["expect"]["verdict"] for c in VERDICT_CASES}
        for verdict in ("created", "current", "migrated", "incompatible"):
            assert verdict in verdicts, f"fixture covers no {verdict} case"

    @pytest.mark.parametrize(
        "case", VERDICT_CASES, ids=[c["expect"]["verdict"] + ": " + c["label"] for c in VERDICT_CASES]
    )
    def test_every_shared_shape(self, case, tmp_path):
        con = _open(tmp_path / "case.db")
        try:
            _apply_verdict_case(con, case)
            expect = case["expect"]

            if expect["verdict"] == "incompatible":
                with pytest.raises(schema_version.IncompatibleDatabaseError) as exc_info:
                    schema_version.check_and_migrate(con, SCHEMA_SQL, str(tmp_path / "case.db"))
                message = str(exc_info.value)
                for pattern in expect.get("message_matches", []):
                    assert re.search(pattern, message), f"{pattern!r} not in {message!r}"
            else:
                result = schema_version.check_and_migrate(
                    con, SCHEMA_SQL, str(tmp_path / "case.db")
                )
                assert result["verdict"] == expect["verdict"]
                if "version" in expect:
                    assert result["version"] == expect["version"]
                if "from" in expect:
                    assert result["from"] == expect["from"]
                for col in expect.get("added_includes", []):
                    assert col in result["added"], f"expected {col} among added"
                if "skipped" in expect:
                    assert result["skipped"] == expect["skipped"]
                # Python spells it skipped_indexes, which is the shared name.
                if "skipped_indexes" in expect:
                    assert result["skipped_indexes"] == expect["skipped_indexes"]

            if "user_version_after" in expect:
                assert con.execute("PRAGMA user_version").fetchone()[0] == expect[
                    "user_version_after"
                ]
            for table, cols in expect.get("columns_exactly", {}).items():
                assert _table_columns(con, table) == cols
            for table, cols in expect.get("columns_absent", {}).items():
                live = _table_columns(con, table)
                for col in cols:
                    assert col not in live, f"{table}.{col} must not have been added"
            present = {
                r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            for table in expect.get("tables_present", []):
                assert table in present, f"expected table {table}"
        finally:
            con.close()
