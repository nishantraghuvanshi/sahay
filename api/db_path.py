"""Shared handling for a configured database target. spec:
.superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.

DB_PATH / TURSO_DATABASE_URL / VOXIKIN_DB have all, at least once, been set to
a Postgres connection string by mistake (agent/postgresql:/... in this working
tree is the evidence). sqlite3.connect() took that literally as a filename and
silently created nested directories and a fresh empty database — no error, no
warning. This module is what db.init() (and any future caller) uses to catch
that once, before anything is created.

A database target is now one of THREE things, not two — this is what the
libSQL/Turso migration changed. The deployed product runs on
`libsql://…turso.io`, so a guard that refuses every `scheme://` refuses the URL
production boots on. The rule is therefore an ALLOWLIST:

  - a filesystem path         -> accepted, byte-identical, as before;
  - REMOTE_SCHEMES over "://" -> accepted, it is a real Turso target;
  - every other scheme        -> refused, exactly as before.

Mirrors agent/src/utils/db-path.js — same rule, no shared runtime. The two are
NOT "kept in step by the tests on each side": that is precisely how they
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

# The only schemes the product can actually reach: libSQL/Turso, over its own
# protocol, a websocket, or plain HTTP. Anything else — postgresql, postgres,
# mysql, mongodb, sqlite, file, redis, … — is refused, because neither runtime
# can open it and taking it literally as a filename is what created
# agent/postgresql:/ in this working tree.
#
# An allowlist, never a denylist: a scheme nobody thought of must fail closed,
# not sail through because it is missing from a list of bad ones.
REMOTE_SCHEMES = frozenset({"libsql", "wss", "ws", "https", "http"})

# Longest name in REMOTE_SCHEMES. Bounds the work done on a huge prefix.
_MAX_SCHEME_LENGTH = max(len(s) for s in REMOTE_SCHEMES)

# Human-readable form of REMOTE_SCHEMES, for the refusal message.
_REMOTE_SCHEME_LIST = ", ".join(f"{s}://" for s in sorted(REMOTE_SCHEMES))

# The authority ends at the first of these.
_AUTHORITY_TERMINATORS = ("/", "?", "#")


class UnsupportedDatabaseTargetError(Exception):
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


def _separator_index(text: str) -> int:
    """The index of the ":/" that makes `text` a URL rather than a path, or
    -1 when `text` is an ordinary filesystem path.

    Stated as one rule: a value is a URL as soon as it contains ":/", UNLESS
    its only ":/" is a Windows drive separator (see
    _is_windows_drive_separator). A drive letter can occur once, at the start
    — so after exempting it we look once more for a further ":/", and a
    second one is a separator regardless.

    Cost: at most three linear scans (str.find ":/" twice, "@" once). No
    regex ever scans the whole string, so there is no ReDoS surface.
    """
    idx = text.find(":/")
    if idx == -1:
        return -1
    if not _is_windows_drive_separator(text, idx):
        return idx
    return text.find(":/", idx + 2)


def _allowed_remote_host(text: str, idx: int, prefix: str) -> str | None:
    """The host of an allowed remote target, or None when this is not one.

    Every one of these conditions is a place to fail closed, and each is here
    because "probably fine" is how a credential gets logged:

      - the prefix must be EXACTLY a name in REMOTE_SCHEMES (case-insensitive,
        as RFC 3986 schemes are). `/mnt/libsql`, ` libsql` and `xlibsql` are
        not, and are refused rather than guessed at;
      - the separator must be "://". `libsql:/host` is not a URL either
        runtime can open, and its single slash means there is no authority to
        trust;
      - the authority must be non-empty. `libsql:///x` names no host, so
        there is nothing to keep and nothing to reach.

    The authority ends at the first "/", "?" or "#". Everything after it is
    dropped rather than kept, because a Turso URL routinely carries the auth
    token in its query string (`?authToken=…`) — keeping "scheme and host"
    means the boot log still says WHICH database is live, while a token in
    the query cannot ride along. Userinfo is dropped for the same reason, at
    the LAST "@" in the authority so a password containing "@" cannot split
    it.
    """
    # Bound the work before touching the prefix: a 4M-character prefix cannot
    # be a scheme name, and lower-casing it to find that out would allocate 4M
    # characters to reach the same answer.
    if not 2 <= len(prefix) <= _MAX_SCHEME_LENGTH:
        return None
    if prefix.lower() not in REMOTE_SCHEMES:
        return None
    if text[idx + 2 : idx + 3] != "/":
        return None

    start = idx + 3
    end = len(text)
    for terminator in _AUTHORITY_TERMINATORS:
        found = text.find(terminator, start)
        if found != -1:
            end = min(end, found)
    authority = text[start:end]
    at = authority.rfind("@")
    host = authority if at == -1 else authority[at + 1 :]
    return host or None


def classify_database_target(value) -> tuple[str, str | None, str | None]:
    """The single predicate redact_credentials, assert_database_target and
    is_remote_target all ask. Returns `(kind, scheme_or_prefix, host)` where
    kind is exactly one of:

      "path"     an ordinary filesystem path        -> (kind, None, None)
      "remote"   a reachable libSQL/Turso URL       -> (kind, scheme, host)
      "refused"  anything else                      -> (kind, prefix, None)
    """
    text = value if isinstance(value, str) else str(value)
    idx = _separator_index(text)
    if idx == -1:
        return ("path", None, None)
    prefix = text[:idx]
    host = _allowed_remote_host(text, idx, prefix)
    if host is None:
        return ("refused", prefix, None)
    return ("remote", prefix, host)


def is_remote_target(value) -> bool:
    """Whether `value` is a reachable remote database URL."""
    return classify_database_target(value)[0] == "remote"


def redact_credentials(value) -> str:
    """Render a database target safe for a log line or an error message.
    Mirrors agent/src/utils/db-path.js's redactCredentials byte for byte; see
    that file's docstring for the full rationale.

    Exactly three outcomes, one per verdict, and there is no fourth:

      - a filesystem path -> returned byte-identical, so a real path can
        never be corrupted into pointing at a different database.
      - an allowed remote URL -> `scheme://host`. This is the case the
        deployed product is in, so coarsening it to `<scheme>://<redacted>`
        would mean the boot log stops saying which database is live — an
        observability regression in the normal case. Userinfo, path and query
        do not survive, so a token cannot ride out in any of them.
      - anything else -> coarsened. No character after the separator
        survives, and what precedes it survives only when the whole prefix is
        itself a scheme name of two or more characters — so
        "1abc://user:pw@host", "://user:pw@host" and "/mnt/1x://user:pw@host",
        whose prefixes are really mis-split credentials or paths, all come out
        "<redacted>://<redacted>".

    This used to require the whole value to *start* with a scheme
    (`_URL_SCHEME_RE.match`), which left every one of these unredacted —
    "://user:pw@host" (no scheme at all), "1abc:/user:pw@host" (digit-led),
    "$$$:/user:pw@host" (punctuation-led), "/mnt/1x:/user:pw@host" (a
    scheme-looking run after a real path prefix) — because each was a case
    where the anchored match simply failed and the value fell through
    untouched, credential intact. The remote branch above is NOT that
    fallthrough returning: it is reached only for a prefix that exactly
    matches an allowlisted scheme, and it still drops userinfo, path and
    query by construction rather than by pattern.

    Never throws on any input, including None, a number, or an empty
    string: coerced to str() first, and every operation after that is a
    substring search and slicing, neither of which can raise.
    """
    text = value if isinstance(value, str) else str(value)
    kind, prefix, host = classify_database_target(text)
    if kind == "path":
        return text
    if kind == "remote":
        return f"{prefix}://{host}"
    label = prefix if _CLEAN_SCHEME_RE.fullmatch(prefix) else "<redacted>"
    return f"{label}://<redacted>"


def assert_database_target(value: str, var_name: str | None = None) -> None:
    """Reject a configured value neither runtime can open — a connection
    string for some other database engine (postgresql://, postgres:/,
    mysql://, mongodb://, sqlite://, ...).

    It asks classify_database_target, the same predicate redact_credentials
    asks, and renders the offending value through redact_credentials. That
    coupling is the point, not an implementation detail: this function used
    to reject on `^scheme:/+` while the Node redactor only coarsened on
    "://", so the two runtimes disagreed about what a connection string even
    was and the Node guard printed `postgresql:/kinvox:PASSWORD@host/db` in
    clear. Because both now go through one function there is no second
    definition left to drift.

    A plain filesystem path never contains ":/", so this never catches a
    legitimate path — including one containing ':' or '@' elsewhere, e.g.
    `/tmp/a:b/x.db` or `/tmp/a@b/x.db` — and a Windows path
    (`C:/Users/x.db`) is exempted by shape.

    Raises before anything is created or opened; the caller must call this
    ahead of any connect().
    """
    text = value if isinstance(value, str) else str(value)
    if classify_database_target(text)[0] != "refused":
        return
    label = var_name or "the configured database path"
    raise UnsupportedDatabaseTargetError(
        f'{label} is not a usable database target: "{redact_credentials(text)}" is '
        "neither a filesystem path nor a database URL this runtime can reach. "
        "Expected a SQLite file path (e.g. ./voxikin.db) or one of "
        f"{_REMOTE_SCHEME_LIST}."
    )
