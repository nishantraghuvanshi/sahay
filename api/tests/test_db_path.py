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

    # A malformed-scheme leak: the earlier version of this function required
    # the value to *start* with a scheme (`_URL_SCHEME_RE.match`, anchored),
    # so anything where the text before the colon-slash wasn't a clean
    # scheme fell through untouched, credential intact. Fixed to search for
    # ":/" anywhere and coarsen unconditionally — no validity gate.
    @pytest.mark.parametrize(
        "label,value",
        [
            ("no scheme at all before :/", "://user:SECRET@host"),
            ("a digit-led scheme", "1abc://user:SECRET@host"),
            ("a punctuation-led scheme", "$$$://user:SECRET@host"),
            ("a scheme-shaped run after a real path prefix", "/mnt/1x://user:SECRET@host"),
        ],
    )
    def test_still_coarsened_not_returned_raw(self, label, value):
        redacted = redact_credentials(value)
        assert "SECRET" not in redacted, f"{label}: leaked -> {redacted!r}"
        assert "user:" not in redacted, f"{label}: leaked -> {redacted!r}"

    def test_postgresql_url_collapses_to_scheme_redacted(self):
        assert redact_credentials("postgresql://u:s@h") == "postgresql://<redacted>"

    def test_sqlite_triple_slash_no_authority_is_coarsened_too(self):
        assert redact_credentials("sqlite:///abs/path.db") == "sqlite://<redacted>"

    def test_embedded_scheme_after_a_real_path_prefix_redacts_the_secret(self):
        redacted = redact_credentials("/mnt/backups/scp://deploy:build@2024/release.db")
        assert "build" not in redacted
        assert "2024" not in redacted

    def test_a_plain_filesystem_path_is_untouched(self):
        assert redact_credentials("/data/voxikin.db") == "/data/voxikin.db"

    def test_a_path_with_at_but_no_scheme_is_untouched(self):
        assert redact_credentials("/tmp/a@b/x.db") == "/tmp/a@b/x.db"

    def test_a_path_with_colon_but_no_scheme_is_untouched(self):
        assert redact_credentials("/tmp/a:b/x.db") == "/tmp/a:b/x.db"

    @pytest.mark.parametrize(
        "label,value",
        [
            ("None", None),
            ("a number", 5),
            ("an empty string", ""),
            ("a lone ':/'", "://"),
            ("a null byte", "\x00abc://x"),
            ("whitespace-padded", "   \t ://x   "),
            ("unicode", "ünïcödé://x"),
        ],
    )
    def test_never_throws(self, label, value):
        redact_credentials(value)  # must not raise

    def test_never_throws_on_multi_megabyte_input(self):
        redact_credentials("a" * 4_000_000)  # must not raise

    def test_no_redos_long_scheme_char_run_no_colon_slash(self):
        import time

        start = time.monotonic()
        redact_credentials("a" * 4_000_000)
        assert time.monotonic() - start < 1.0

    def test_no_redos_long_scheme_char_run_before_colon_slash(self):
        import time

        start = time.monotonic()
        redact_credentials(("a" * 4_000_000) + "://x")
        assert time.monotonic() - start < 1.0

    def test_no_redos_many_repetitions_of_a_colon_slash_slash(self):
        import time

        start = time.monotonic()
        redact_credentials("a://" * 1_000_000)
        assert time.monotonic() - start < 1.0
