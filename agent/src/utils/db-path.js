'use strict';

/**
 * Shared handling for a configured database target. spec:
 * .superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.
 *
 * DB_PATH / TURSO_DATABASE_URL / VOXIKIN_DB have all, at least once, been set
 * to a Postgres connection string by mistake (agent/postgresql:/... in this
 * working tree is the evidence). SqliteRepository took that literally as a
 * filename and silently created nested directories and a fresh empty
 * database — no error, no warning. This module is what every caller of
 * SqliteRepository (server.js, the scripts, tests) shares so that mistake is
 * caught once, in one place, before anything is created.
 *
 * A database target is now one of THREE things, not two — this is what the
 * libSQL/Turso migration changed. The deployed product runs on
 * `libsql://…turso.io`, so a guard that refuses every `scheme://` refuses the
 * URL production boots on. The rule is therefore an ALLOWLIST:
 *
 *   - a filesystem path            -> accepted, byte-identical, as before;
 *   - REMOTE_SCHEMES over "://"    -> accepted, it is a real Turso target;
 *   - every other scheme           -> refused, exactly as before.
 *
 * api/db_path.py implements the identical rule for the Python runtime. The
 * two are no longer "kept in step by the tests on each side" — that is
 * precisely how they drifted, one keying on "://" and the other on ":/", in
 * opposite directions, for four review rounds. They now assert against ONE
 * shared table of cases, api/fixtures/db-path-cases.json, read by both
 * agent/tests/db-path.test.js and api/tests/test_db_path.py.
 */

/**
 * Rendered verbatim in the redacted output only when the WHOLE prefix before
 * the separator is itself a scheme name of AT LEAST TWO characters. The `+`
 * (not `*`) is the length rule: a one-character prefix is never rendered,
 * because a one-character prefix is what a Windows drive letter looks like
 * and this pattern must not be the thing that decides between the two.
 *
 * Anchored at both ends, one greedy character class, no alternation: it is
 * deterministic and linear in the prefix length, so it cannot backtrack.
 */
const CLEAN_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+$/;

const SLASH = 0x2f;

/**
 * The only schemes this adapter can actually reach: libSQL/Turso, over its
 * own protocol, a websocket, or plain HTTP. Anything else — postgresql,
 * postgres, mysql, mongodb, sqlite, file, redis, … — is refused, because
 * this adapter cannot open it and taking it literally as a filename is what
 * created agent/postgresql:/ in this working tree.
 *
 * An allowlist, never a denylist: a scheme nobody thought of must fail
 * closed, not sail through because it is missing from a list of bad ones.
 */
const REMOTE_SCHEMES = new Set(['libsql', 'wss', 'ws', 'https', 'http']);

/** Longest name in REMOTE_SCHEMES. Bounds the work done on a huge prefix. */
const MAX_SCHEME_LENGTH = Math.max(...[...REMOTE_SCHEMES].map((s) => s.length));

/** The authority ends at the first of these. */
const AUTHORITY_TERMINATORS = ['/', '?', '#'];

/** Human-readable form of REMOTE_SCHEMES, for the refusal message. */
const REMOTE_SCHEME_LIST = [...REMOTE_SCHEMES].map((s) => `${s}://`).join(', ');

class UnsupportedDatabaseTargetError extends Error {}

/**
 * Is the ":/" at `idx` the ":" of a Windows drive letter rather than the
 * separator of a connection string?
 *
 * This is the ONLY exemption, and it is decided on length and shape alone —
 * never on "the prefix starts with a letter", which is the gate four earlier
 * rounds used to skip redaction and which let `postgresql:/`, `1abc:/` and
 * `$$$://` through. All four conditions must hold:
 *
 *   1. exactly one character precedes the colon (idx === 1). RFC 3986 scheme
 *      names are two characters or more, so a one-character prefix cannot be
 *      a real scheme;
 *   2. that character is an ASCII letter — a drive letter is A-Z;
 *   3. exactly one slash follows the colon. "//" opens a URI authority, and
 *      an authority is the only place userinfo can live, so `a://…` is a
 *      connection string however short its scheme looks;
 *   4. the value contains no "@" anywhere. "@" is the userinfo delimiter; a
 *      value carrying one is treated as a credential no matter what shape
 *      surrounds it. This is what closes `a:/user:pw@host`, whose first
 *      three conditions are indistinguishable from `C:/Users/x/data.db`.
 *
 * Anything that is not all four redacts. When in doubt, redact.
 */
function _isWindowsDriveSeparator(str, idx) {
  if (idx !== 1) return false;
  const c = str.charCodeAt(0);
  const isAsciiLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  if (!isAsciiLetter) return false;
  if (str.charCodeAt(3) === SLASH) return false; // "C://…" — an authority, not a drive
  return str.indexOf('@') === -1;
}

/**
 * The index of the ":/" that makes `str` a URL rather than a path, or -1
 * when `str` is an ordinary filesystem path.
 *
 * Stated as one rule: a value is a URL as soon as it contains ":/", UNLESS
 * its only ":/" is a Windows drive separator (see
 * _isWindowsDriveSeparator). A drive letter can occur once, at the start —
 * so after exempting it we look once more for a further ":/", and a second
 * one is a separator regardless.
 *
 * Cost: at most three linear scans (indexOf ':/' twice, indexOf '@' once).
 * No regex ever scans the whole string, so there is no ReDoS surface — the
 * shape `/([a-zA-Z][a-zA-Z0-9+.-]*):\/\//` hung for minutes on 4M characters.
 */
function _separatorIndex(str) {
  const idx = str.indexOf(':/');
  if (idx === -1) return -1;
  if (!_isWindowsDriveSeparator(str, idx)) return idx;
  return str.indexOf(':/', idx + 2);
}

/**
 * The host of an allowed remote target, or null when this is not one.
 *
 * Every one of these conditions is a place to fail closed, and each is here
 * because "probably fine" is how a credential gets logged:
 *
 *   - the prefix must be EXACTLY a name in REMOTE_SCHEMES (case-insensitive,
 *     as RFC 3986 schemes are). `/mnt/libsql`, ` libsql` and `xlibsql` are
 *     not, and are refused rather than guessed at;
 *   - the separator must be "://". `libsql:/host` is not a URL this adapter
 *     can open, and its single slash means there is no authority to trust;
 *   - the authority must be non-empty. `libsql:///x` names no host, so there
 *     is nothing to keep and nothing to reach.
 *
 * The authority ends at the first "/", "?" or "#". Everything after it is
 * dropped rather than kept, because a Turso URL routinely carries the auth
 * token in its query string (`?authToken=…`) — keeping "scheme and host"
 * means the boot log still says WHICH database is live, while a token in
 * the query cannot ride along. Userinfo is dropped for the same reason, at
 * the LAST "@" in the authority so a password containing "@" cannot split it.
 */
function _allowedRemoteHost(str, idx, prefix) {
  // Bound the work before touching the prefix: a 4M-character prefix cannot
  // be a scheme name, and lower-casing it to find that out would allocate 4M
  // characters to reach the same answer.
  if (prefix.length < 2 || prefix.length > MAX_SCHEME_LENGTH) return null;
  if (!REMOTE_SCHEMES.has(prefix.toLowerCase())) return null;
  if (str.charCodeAt(idx + 2) !== SLASH) return null;

  const start = idx + 3;
  let end = str.length;
  for (const terminator of AUTHORITY_TERMINATORS) {
    const found = str.indexOf(terminator, start);
    if (found !== -1) end = Math.min(end, found);
  }
  const authority = str.slice(start, end);
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  return host === '' ? null : host;
}

/**
 * The single predicate redactCredentials, assertDatabaseTarget and
 * isRemoteTarget all ask. Exactly three verdicts:
 *
 *   {kind: 'path'}                     an ordinary filesystem path
 *   {kind: 'remote', scheme, host}     a reachable libSQL/Turso URL
 *   {kind: 'refused', prefix}          anything else
 *
 * @param {*} value
 * @returns {{kind: 'path'|'remote'|'refused', scheme: string|null,
 *            host: string|null, prefix: string|null}}
 */
function classifyDatabaseTarget(value) {
  const str = String(value);
  const idx = _separatorIndex(str);
  if (idx === -1) return { kind: 'path', scheme: null, host: null, prefix: null };
  const prefix = str.slice(0, idx);
  const host = _allowedRemoteHost(str, idx, prefix);
  if (host === null) return { kind: 'refused', scheme: null, host: null, prefix };
  return { kind: 'remote', scheme: prefix, host, prefix };
}

/** @returns {boolean} true when `value` is a reachable remote database URL. */
function isRemoteTarget(value) {
  return classifyDatabaseTarget(value).kind === 'remote';
}

/**
 * Redact a value before it reaches a log line or an error message. A
 * database target is meant to be a SQLite path or a Turso URL, but DB_PATH,
 * DATABASE_URL and VOXIKIN_DB have all been seen set to a Postgres
 * connection string by mistake — logging or throwing one verbatim would put
 * the password in the log or in the crash report.
 *
 * Exactly three outcomes, one per verdict, and there is no fourth:
 *
 *   - a filesystem path -> returned byte-identical, not even copied through
 *     a regex, so a real path can never be corrupted into pointing at the
 *     wrong database.
 *   - an allowed remote URL -> `scheme://host`. This is the case the
 *     deployed product is in, so coarsening it to `<scheme>://<redacted>`
 *     would mean the boot log stops saying which database is live — an
 *     observability regression in the normal case. Userinfo, path and query
 *     do not survive, so a token cannot ride out in any of them.
 *   - anything else -> coarsen it. No character after the separator
 *     survives, and what precedes it survives only when the whole prefix is
 *     itself a scheme name of two or more characters — so "1abc://user:pw@host",
 *     "://user:pw@host" and "/mnt/1x://user:pw@host", whose prefixes are
 *     really mis-split credentials or paths, all come out
 *     "<redacted>://<redacted>".
 *
 * Four earlier rounds each added an outcome that returned the input once a
 * separator had been found — extract just the userinfo, scope to the
 * authority, bail out when the prefix isn't a valid scheme — and every one
 * of those was a place a credential slipped through. The remote branch above
 * is NOT that bug returning: it is reached only for a prefix that exactly
 * matches an allowlisted scheme, and it still drops userinfo, path and query
 * by construction rather than by pattern.
 *
 * Never throws on any input — null, undefined, a number, empty string, a
 * lone "://", a null byte, unicode, whitespace padding, multi-megabyte:
 * String() tolerates all of it, and indexOf, slice and test cannot throw.
 *
 * @param {*} value
 * @returns {string}
 */
function redactCredentials(value) {
  const str = String(value);
  const verdict = classifyDatabaseTarget(str);
  if (verdict.kind === 'path') return str;
  if (verdict.kind === 'remote') return `${verdict.scheme}://${verdict.host}`;
  return `${CLEAN_SCHEME_RE.test(verdict.prefix) ? verdict.prefix : '<redacted>'}://<redacted>`;
}

/**
 * Reject a configured value this adapter cannot open — a connection string
 * for some other database engine (postgresql://, postgres:/, mysql://,
 * mongodb://, sqlite://, ...).
 *
 * It asks classifyDatabaseTarget, the same predicate redactCredentials asks,
 * and renders the offending value through redactCredentials. That coupling
 * is the point, not an implementation detail: this function used to reject
 * on `^scheme:/+` while the redactor only coarsened on "://", so
 * `postgresql:/kinvox:PASSWORD@host/db` was rejected AND printed in clear by
 * the very guard meant to protect it. Because both now go through one
 * function there is no second definition left to drift — including the
 * definition of which schemes are reachable, which SqliteRepository also
 * asks through isRemoteTarget rather than keeping a regex of its own.
 *
 * A plain filesystem path never contains ":/", so this never catches a
 * legitimate path — including one containing ':' or '@' elsewhere, e.g.
 * `/tmp/a:b/x.db` or `/tmp/a@b/x.db` — and a Windows path (`C:/Users/x.db`)
 * is exempted by shape.
 *
 * Throws before anything is created or opened; the caller must call this
 * ahead of any mkdir/open/connect.
 *
 * @param {string} value
 * @param {string|null} [varName] - the env var this value came from, for the
 *   error message. Falls back to a generic label when unknown (e.g. a test
 *   passing dbPath directly rather than through an env var).
 */
function assertDatabaseTarget(value, varName) {
  const str = String(value);
  if (classifyDatabaseTarget(str).kind !== 'refused') return;
  const label = varName || 'the configured database path';
  throw new UnsupportedDatabaseTargetError(
    `${label} is not a usable database target: "${redactCredentials(str)}" is neither a ` +
      `filesystem path nor a database URL this adapter can reach. Expected a SQLite file ` +
      `path (e.g. ./data/voiceagent.db) or one of ${REMOTE_SCHEME_LIST}.`
  );
}

/**
 * The env-var precedence every caller (server.js, seed-medications.js,
 * make-call.js, ...) resolves the same way, minus the hand-copied
 * `process.env.DB_PATH || process.env.TURSO_DATABASE_URL || ...` chain that
 * used to live in each file and had already drifted out of step once
 * (ground-truth.js never read VOXIKIN_DB). Centralising the lookup means the
 * only thing a caller decides is which var names apply to it, in order — and
 * it is what keeps the NAME available, so a refusal can say which variable
 * was misconfigured rather than just printing a value.
 *
 * @param {string[]} varNames
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{value: string|undefined, varName: string|null}}
 */
function resolveConfiguredDbPath(varNames, env = process.env) {
  for (const name of varNames) {
    if (env[name]) return { value: env[name], varName: name };
  }
  return { value: undefined, varName: null };
}

module.exports = {
  redactCredentials,
  assertDatabaseTarget,
  classifyDatabaseTarget,
  isRemoteTarget,
  resolveConfiguredDbPath,
  REMOTE_SCHEMES,
  UnsupportedDatabaseTargetError,
};
