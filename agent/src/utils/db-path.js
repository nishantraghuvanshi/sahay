'use strict';

/**
 * Shared handling for a configured SQLite path. spec:
 * .superpowers/sdd/modularise-boundaries/task-4-brief.md, controller addendum.
 *
 * DB_PATH / DATABASE_URL / VOXIKIN_DB have all, at least once, been set to a
 * Postgres connection string by mistake (agent/postgresql:/... in this
 * working tree is the evidence). SqliteRepository took that literally as a
 * filename and silently created nested directories and a fresh empty
 * database — no error, no warning. This module is what every caller of
 * SqliteRepository (server.js, the scripts, tests) shares so that mistake is
 * caught once, in one place, before anything is created.
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

class NotAFilesystemPathError extends Error {}

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
 * The single predicate both redactCredentials and assertFilesystemPath ask.
 * Returns the index of the ":/" that makes `str` a connection string, or -1
 * when `str` is an ordinary filesystem path.
 *
 * Stated as one rule: a value is a connection string as soon as it contains
 * ":/", UNLESS its only ":/" is a Windows drive separator (see
 * _isWindowsDriveSeparator). A drive letter can occur once, at the start —
 * so after exempting it we look once more for a further ":/", and a second
 * one is a separator regardless.
 *
 * Cost: at most three linear scans (indexOf ':/' twice, indexOf '@' once)
 * plus one anchored, non-backtracking test over the prefix. No regex ever
 * scans the whole string, so there is no ReDoS surface — the shape
 * `/([a-zA-Z][a-zA-Z0-9+.-]*):\/\//` hung for minutes on 4M characters.
 */
function connectionStringSeparatorIndex(str) {
  const idx = str.indexOf(':/');
  if (idx === -1) return -1;
  if (!_isWindowsDriveSeparator(str, idx)) return idx;
  return str.indexOf(':/', idx + 2);
}

/**
 * Redact a value before it reaches a log line or an error message. db_path is
 * meant to be a SQLite filesystem path, but DB_PATH, DATABASE_URL and
 * VOXIKIN_DB have all been seen set to a Postgres connection string by
 * mistake — logging or throwing one verbatim would put the password in the
 * log or in the crash report.
 *
 * Exactly two outcomes, and there is no third:
 *
 *   - the value is a connection string (connectionStringSeparatorIndex found
 *     a separator) -> coarsen it. No character after the separator survives,
 *     and what precedes it survives only when the whole prefix is itself a
 *     scheme name of two or more characters — so "1abc://user:pw@host",
 *     "://user:pw@host" and "/mnt/1x://user:pw@host", whose prefixes are
 *     really mis-split credentials or paths, all come out
 *     "<redacted>://<redacted>".
 *   - it is not -> return it byte-identical, not even copied through a
 *     regex, so a real path can never be corrupted into pointing at the
 *     wrong database.
 *
 * Four earlier rounds each added a third outcome — extract just the
 * userinfo, scope to the authority, bail out when the prefix isn't a valid
 * scheme — and every one of those decisions was a place a credential
 * slipped through, the last returning the connection string verbatim. Any
 * condition that can return the original once a separator has been found is
 * that bug again.
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
  const idx = connectionStringSeparatorIndex(str);
  if (idx === -1) return str;
  const prefix = str.slice(0, idx);
  return `${CLEAN_SCHEME_RE.test(prefix) ? prefix : '<redacted>'}://<redacted>`;
}

/**
 * Reject a configured value that is evidently not a filesystem path — a
 * connection string (postgresql://, postgres:/, mysql://, sqlite://, ...).
 *
 * It asks connectionStringSeparatorIndex, the same predicate
 * redactCredentials asks, and renders the offending value through
 * redactCredentials. That coupling is the point, not an implementation
 * detail: this function used to reject on `^scheme:/+` while the redactor
 * only coarsened on "://", so `postgresql:/kinvox:PASSWORD@host/db` was
 * rejected AND printed in clear by the very guard meant to protect it.
 * Because both now go through one function there is no second definition
 * left to drift.
 *
 * A plain filesystem path never contains ":/", so this never catches a
 * legitimate path — including one containing ':' or '@' elsewhere, e.g.
 * `/tmp/a:b/x.db` or `/tmp/a@b/x.db` — and a Windows path (`C:/Users/x.db`)
 * is exempted by shape.
 *
 * Throws before anything is created or opened; the caller must call this
 * ahead of any mkdir/open.
 *
 * @param {string} value
 * @param {string|null} [varName] - the env var this value came from, for the
 *   error message. Falls back to a generic label when unknown (e.g. a test
 *   passing dbPath directly rather than through an env var).
 */
function assertFilesystemPath(value, varName) {
  const str = String(value);
  if (connectionStringSeparatorIndex(str) === -1) return;
  const label = varName || 'the configured database path';
  throw new NotAFilesystemPathError(
    `${label} is not a filesystem path: "${redactCredentials(str)}" looks like a ` +
      `<scheme>:// connection string. Expected a SQLite file path (e.g. ./data/voiceagent.db).`
  );
}

/**
 * The env-var precedence every caller (server.js, seed-medications.js,
 * make-call.js, ...) resolves the same way, minus the hand-copied
 * `process.env.DB_PATH || process.env.DATABASE_URL || ...` chain that used
 * to live in each file and had already drifted out of step once
 * (ground-truth.js never read VOXIKIN_DB). Centralising the lookup means the
 * only thing a caller decides is which var names apply to it, in order.
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
  assertFilesystemPath,
  connectionStringSeparatorIndex,
  resolveConfiguredDbPath,
  NotAFilesystemPathError,
};
