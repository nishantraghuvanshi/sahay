"""db_path.py — reject a DB_PATH that is not a filesystem path. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.

Pure stdlib, no FastAPI dependency — see test_schema_version.py's module
docstring for why this matters in the environment this was written in.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from api.db_path import (  # noqa: E402
    NotAFilesystemPathError,
    assert_filesystem_path,
    redact_credentials,
)


class TestAssertFilesystemPath:
    def test_rejects_a_postgresql_connection_string(self):
        with pytest.raises(NotAFilesystemPathError):
            assert_filesystem_path("postgresql://kinvox:kinvox@localhost:5432/kinvox", "VOXIKIN_DB")

    @pytest.mark.parametrize("scheme", ["postgres", "mysql", "sqlite", "mongodb"])
    def test_rejects_any_scheme_not_just_postgresql(self, scheme):
        with pytest.raises(NotAFilesystemPathError):
            assert_filesystem_path(f"{scheme}://user:pass@host/db", "VOXIKIN_DB")

    def test_rejects_the_pathlib_collapsed_single_slash_form(self):
        # pathlib.Path("postgresql://a:b@c/d") collapses "//" to "/" the
        # moment it's constructed — this is the exact string that shape
        # produces, and it's what DB_PATH actually holds by the time
        # db.init() can check it. See agent/postgresql:/kinvox:... in this
        # working tree, which is this exact collapse.
        with pytest.raises(NotAFilesystemPathError):
            assert_filesystem_path("postgresql:/kinvox:kinvox@localhost:5432/kinvox", "VOXIKIN_DB")

    def test_error_names_the_variable_that_was_set(self):
        with pytest.raises(NotAFilesystemPathError, match="VOXIKIN_DB"):
            assert_filesystem_path("postgresql://a:b@c/d", "VOXIKIN_DB")

    def test_falls_back_to_a_generic_label_when_no_variable_name_given(self):
        with pytest.raises(NotAFilesystemPathError, match="configured database path"):
            assert_filesystem_path("postgresql://a:b@c/d")

    def test_error_message_never_contains_the_raw_password(self):
        with pytest.raises(NotAFilesystemPathError) as exc_info:
            assert_filesystem_path("postgresql://kinvox:supersecret@localhost:5432/kinvox", "VOXIKIN_DB")
        assert "supersecret" not in str(exc_info.value)

    def test_a_plain_absolute_path_is_accepted(self):
        assert_filesystem_path("/data/voxikin.db")  # does not raise

    def test_a_path_containing_colon_is_accepted(self):
        assert_filesystem_path("/tmp/backup:2026-08-30/x.db")  # does not raise

    def test_a_path_containing_at_is_accepted_the_addendums_named_example(self):
        assert_filesystem_path("/tmp/a@b/x.db")  # does not raise

    def test_a_relative_path_is_accepted(self):
        assert_filesystem_path("./voxikin.db")  # does not raise


class TestRedactCredentials:
    def test_collapses_everything_after_scheme_so_no_password_survives(self):
        redacted = redact_credentials("postgresql://kinvox:secretpw@localhost:5432/kinvox")
        assert "secretpw" not in redacted
        assert redacted.startswith("postgresql://")

    def test_a_plain_filesystem_path_is_untouched(self):
        assert redact_credentials("/data/voxikin.db") == "/data/voxikin.db"

    def test_a_path_with_at_but_no_scheme_is_untouched(self):
        assert redact_credentials("/tmp/a@b/x.db") == "/tmp/a@b/x.db"
