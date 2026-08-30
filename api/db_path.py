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


_SCHEME_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-"
)
_ASCII_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")


def redact_credentials(value) -> str:
    """Collapse a `scheme:/...` value — ANYWHERE in the string, not only at
    the start — to `scheme://<redacted>` before it reaches a log line or an
    error message. Mirrors agent/src/utils/db-path.js's redactCredentials;
    see that file's docstring for the full rationale. In short: this used
    to require the whole value to *start* with a scheme
    (`_URL_SCHEME_RE.match`), which left every one of these unredacted —
    ":/user:pw@host" (no scheme at all), "1abc:/user:pw@host" (digit-led),
    "$$$:/user:pw@host" (punctuation-led), "/mnt/1x:/user:pw@host" (a
    scheme-looking run after a real path prefix) — because each was a case
    where the anchored match simply failed and the value fell through
    untouched, credential intact. There is no such fallthrough now: finding
    ":/" anywhere is the only thing checked, and it always produces a fully
    coarsened `scheme://<redacted>` — `<redacted>://<redacted>` when
    whatever precedes it isn't a clean scheme — so no userinfo character,
    and no part of an unclean prefix, ever reaches the output.

    A value with no ":/" anywhere is an ordinary path and is returned
    byte-identical.

    Never throws on any input, including None, a number, or an empty
    string: coerced to str() first, and every operation after that is a
    substring search and slicing, neither of which can raise.
    """
    text = value if isinstance(value, str) else str(value)
    idx = text.find(":/")
    if idx == -1:
        return text

    start = idx
    while start > 0 and text[start - 1] in _SCHEME_CHARS:
        start -= 1
    scheme = text[start:idx]
    starts_with_letter = bool(scheme) and scheme[0] in _ASCII_LETTERS
    scheme_label = scheme if starts_with_letter else "<redacted>"
    return f"{scheme_label}://<redacted>"


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
