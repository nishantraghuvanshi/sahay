"""schema_version.py — the three open-time verdicts. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md

Pure sqlite3 + pathlib, no FastAPI dependency, so this file only needs pytest
itself to run (neither pytest nor fastapi were installed in the environment
this was written in — see task-4-report.md for what was verified by running
the bodies below directly with plain asserts instead).
"""
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
        con = _open(tmp_path / "old.db")
        con.executescript(
            "CREATE TABLE patients (id TEXT PRIMARY KEY, phone_e164 TEXT NOT NULL UNIQUE, "
            "created_at TEXT NOT NULL);"
            "CREATE TABLE medications (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, "
            "name TEXT NOT NULL, dose TEXT NOT NULL);"
        )
        result = schema_version.check_and_migrate(con, SCHEMA_SQL, "old.db")
        assert result["verdict"] == "migrated"
        assert result["from"] == 0
        assert result["version"] == 1
        assert "patients.timezone" in result["added"]
        assert "medications.slots" in result["added"]
        assert con.execute("PRAGMA user_version").fetchone()[0] == 1
        con.close()

    def test_never_adds_a_not_null_no_default_column_it_is_skipped_not_thrown(self, tmp_path):
        con = _open(tmp_path / "stripped.db")
        con.executescript(
            "CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT);"
            "CREATE TABLE dose_events (id TEXT PRIMARY KEY, status TEXT);"
            "INSERT INTO medications (id, name) VALUES ('m1', 'Metformin');"
        )
        result = schema_version.check_and_migrate(con, SCHEMA_SQL, "stripped.db")
        assert result["verdict"] == "migrated"
        assert "medications.patient_id" in result["skipped"]
        assert "medications.dose" in result["skipped"]
        assert "medications.slots" in result["added"]  # has a DEFAULT — safe
        row = con.execute("SELECT name FROM medications WHERE id = 'm1'").fetchone()
        assert row["name"] == "Metformin"
        con.close()


class TestVerdictIncompatible:
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
