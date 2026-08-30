"""Shared handling for a configured SQLite path. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.

DB_PATH / DATABASE_URL / VOXIKIN_DB have all, at least once, been set to a
Postgres connection string by mistake (agent/postgresql:/... in this working
tree is the evidence). sqlite3.connect() took that literally as a filename
and silently created nested directories and a fresh empty database — no
error, no warning. This module is what db.init() (and any future caller)
uses to catch that once, before anything is created.

Mirrors agent/src/utils/db-path.js — same algorithm, no shared runtime, kept
in step by the tests on each side.
"""
from __future__ import annotations

import re

# One or more slashes after the colon, not exactly "://": pathlib.Path()
# collapses a double slash to one the moment a raw env value like
# "postgresql://user:pass@host/db" is wrapped in Path() — see
# agent/postgresql:/kinvox:... in this working tree, which is that exact
# collapse. DB_PATH is a Path by the time init() can validate it, so the
# check has to recognise the collapsed form too. A real absolute filesystem
# path starts with '/', never with a leading scheme letter, so this never
# catches one — including `/tmp/a@b/x.db`.
_URL_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:/+")


class NotAFilesystemPathError(Exception):
    pass


def redact_credentials(value: str) -> str:
    """Collapse a `scheme:/...` value (see _URL_SCHEME_RE for why one slash
    is enough) to `scheme://<redacted>` before it reaches a log line or an
    error message. A value with no scheme prefix — an ordinary filesystem
    path — is returned untouched.

    Deliberately coarse rather than trying to extract just the userinfo: a
    real filesystem path never starts with a scheme, so nothing legitimate
    is ever touched, and there is no per-character parsing left to get
    wrong.
    """
    if not _URL_SCHEME_RE.match(value):
        return value
    scheme = value.split(":", 1)[0]
    return f"{scheme}://<redacted>"


def assert_filesystem_path(value: str, var_name: str | None = None) -> None:
    """Reject a configured value that is evidently not a filesystem path — a
    `<scheme>://` connection string (postgresql://, postgres://, mysql://,
    sqlite://, ...). A plain filesystem path never contains "://", so this
    never catches a legitimate path — including one containing ':' or '@'
    elsewhere, e.g. `/tmp/a@b/x.db`.

    Raises before anything is created or opened; the caller must call this
    ahead of any connect().
    """
    if _URL_SCHEME_RE.match(value):
        label = var_name or "the configured database path"
        raise NotAFilesystemPathError(
            f'{label} is not a filesystem path: "{redact_credentials(value)}" looks '
            "like a <scheme>:// connection string. Expected a SQLite file path "
            "(e.g. ./voxikin.db)."
        )
