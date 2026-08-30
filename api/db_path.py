"""Shared handling for a configured SQLite path. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.

DB_PATH / DATABASE_URL / VOXIKIN_DB have all, at least once, been set to a
Postgres connection string by mistake (agent/postgresql:/... in this working
tree is the evidence). sqlite3.connect() took that literally as a filename
and silently created nested directories and a fresh empty database — no
error, no warning. This module is what db.init() (and any future caller)
uses to catch that once, before anything is created.

Mirrors agent/src/utils/db-path.js — same rule, no shared runtime. The two
are NOT "kept in step by the tests on each side": that is precisely how they
drifted, this file keying on ":/" and the Node one on "://", in opposite
directions, for four review rounds. They now assert against ONE shared table
of cases, api/fixtures/db-path-cases.json, read by both
api/tests/test_db_path.py and agent/tests/db-path.test.js.
"""
from __future__ import annotations

import re

# Rendered verbatim in the redacted output only when the WHOLE prefix before
# the separator is itself a scheme name of AT LEAST TWO characters. The `+`
# (not `*`) is the length rule: a one-character prefix is never rendered,
# because a one-character prefix is what a Windows drive letter looks like
# and this pattern must not be the thing that decides between the two.
#
# Anchored by fullmatch over the prefix alone, one greedy character class, no
# alternation: deterministic and linear, so it cannot backtrack.
_CLEAN_SCHEME_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]+")

_ASCII_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")


class NotAFilesystemPathError(Exception):
    pass


def _is_windows_drive_separator(text: str, idx: int) -> bool:
    """Is the ":/" at `idx` the ":" of a Windows drive letter rather than the
    separator of a connection string?

    This is the ONLY exemption, and it is decided on length and shape alone —
    never on "the prefix starts with a letter", which is the gate four
    earlier rounds used to skip redaction and which let `postgresql:/`,
    `1abc:/` and `$$$://` through. All four conditions must hold:

      1. exactly one character precedes the colon (idx == 1). RFC 3986 scheme
         names are two characters or more, so a one-character prefix cannot
         be a real scheme;
      2. that character is an ASCII letter — a drive letter is A-Z;
      3. exactly one slash follows the colon. "//" opens a URI authority, and
         an authority is the only place userinfo can live, so `a://…` is a
         connection string however short its scheme looks;
      4. the value contains no "@" anywhere. "@" is the userinfo delimiter; a
         value carrying one is treated as a credential no matter what shape
         surrounds it. This is what closes `a:/user:pw@host`, whose first
         three conditions are indistinguishable from `C:/Users/x/data.db`.

    Anything that is not all four redacts. When in doubt, redact.
    """
    if idx != 1:
        return False
    if text[0] not in _ASCII_LETTERS:
        return False
    if text[3:4] == "/":  # "C://…" — an authority, not a drive
        return False
    return "@" not in text


def connection_string_separator_index(text: str) -> int:
    """The single predicate both redact_credentials and
    assert_filesystem_path ask. Returns the index of the ":/" that makes
    `text` a connection string, or -1 when `text` is an ordinary filesystem
    path.

    Stated as one rule: a value is a connection string as soon as it contains
    ":/", UNLESS its only ":/" is a Windows drive separator (see
    _is_windows_drive_separator). A drive letter can occur once, at the start
    — so after exempting it we look once more for a further ":/", and a
    second one is a separator regardless.

    Cost: at most three linear scans (str.find ":/" twice, "@" once) plus one
    anchored, non-backtracking fullmatch over the prefix. No regex ever scans
    the whole string, so there is no ReDoS surface.
    """
    idx = text.find(":/")
    if idx == -1:
        return -1
    if not _is_windows_drive_separator(text, idx):
        return idx
    return text.find(":/", idx + 2)


def redact_credentials(value) -> str:
    """Coarsen a connection string to `scheme://<redacted>` before it reaches
    a log line or an error message. Mirrors
    agent/src/utils/db-path.js's redactCredentials byte for byte; see that
    file's docstring for the full rationale.

    Exactly two outcomes, and there is no third:

      - the value is a connection string (a separator was found) -> coarsen
        it. No character after the separator survives, and what precedes it
        survives only when the whole prefix is itself a scheme name of two or
        more characters — so "1abc://user:pw@host", "://user:pw@host" and
        "/mnt/1x://user:pw@host", whose prefixes are really mis-split
        credentials or paths, all come out "<redacted>://<redacted>".
      - it is not -> returned byte-identical.

    This used to require the whole value to *start* with a scheme
    (`_URL_SCHEME_RE.match`), which left every one of these unredacted —
    "://user:pw@host" (no scheme at all), "1abc:/user:pw@host" (digit-led),
    "$$$:/user:pw@host" (punctuation-led), "/mnt/1x:/user:pw@host" (a
    scheme-looking run after a real path prefix) — because each was a case
    where the anchored match simply failed and the value fell through
    untouched, credential intact. There is no such fallthrough now: any
    condition that can return the original once a separator has been found is
    that bug again.

    Never throws on any input, including None, a number, or an empty
    string: coerced to str() first, and every operation after that is a
    substring search and slicing, neither of which can raise.
    """
    text = value if isinstance(value, str) else str(value)
    idx = connection_string_separator_index(text)
    if idx == -1:
        return text
    prefix = text[:idx]
    label = prefix if _CLEAN_SCHEME_RE.fullmatch(prefix) else "<redacted>"
    return f"{label}://<redacted>"


def assert_filesystem_path(value: str, var_name: str | None = None) -> None:
    """Reject a configured value that is evidently not a filesystem path — a
    connection string (postgresql://, postgres:/, mysql://, sqlite://, ...).

    It asks connection_string_separator_index, the same predicate
    redact_credentials asks, and renders the offending value through
    redact_credentials. That coupling is the point, not an implementation
    detail: this function used to reject on `^scheme:/+` while the Node
    redactor only coarsened on "://", so the two runtimes disagreed about
    what a connection string even was and the Node guard printed
    `postgresql:/kinvox:PASSWORD@host/db` in clear. Because both now go
    through one function there is no second definition left to drift.

    A plain filesystem path never contains ":/", so this never catches a
    legitimate path — including one containing ':' or '@' elsewhere, e.g.
    `/tmp/a:b/x.db` or `/tmp/a@b/x.db` — and a Windows path
    (`C:/Users/x.db`) is exempted by shape.

    Raises before anything is created or opened; the caller must call this
    ahead of any connect().
    """
    text = value if isinstance(value, str) else str(value)
    if connection_string_separator_index(text) == -1:
        return
    label = var_name or "the configured database path"
    raise NotAFilesystemPathError(
        f'{label} is not a filesystem path: "{redact_credentials(text)}" looks '
        "like a <scheme>:// connection string. Expected a SQLite file path "
        "(e.g. ./voxikin.db)."
    )
