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
 */

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

class NotAFilesystemPathError extends Error {}

/**
 * Redact everything past a `scheme://` out of a value before it reaches a
 * log line or an error message. db_path is meant to be a SQLite filesystem
 * path, but DB_PATH, DATABASE_URL and VOXIKIN_DB have all been seen set to
 * a Postgres connection string by mistake — logging or throwing it verbatim
 * would put the password in the log or the crash report.
 *
 * This used to try to parse out just the userinfo and leave the rest of the
 * value intact. Three rounds of review found three different bypasses of
 * that (a password containing '@', one containing '/', one containing
 * both) — precisely extracting a credential out of an arbitrary string is
 * the wrong job for a log-safety helper to take on. So: no parsing.
 *
 * A value containing "://" is not a filesystem path — a real one never
 * contains that substring — so its details aren't worth the risk of getting
 * a corner case wrong a fourth time. Collapse it to the scheme and nothing
 * else; zero userinfo characters can survive because none of the original
 * string after the scheme is kept, by construction rather than by pattern.
 * A value with no "://" is an ordinary path and is returned completely
 * untouched — not even copied through a regex — so a real path can never be
 * corrupted into pointing at the wrong database (that mattered more than
 * the leak: assertFilesystemPath below already makes a value carrying a URL
 * scheme refuse to open outright, so this is defence-in-depth for a value
 * about to be rejected anyway, not the primary defense).
 *
 * Never throws: String(value) tolerates any input, and the only other
 * operation is a single non-backtracking regex match. Not new URL() for the
 * same reason as before — it throws on the exact strings this function must
 * still produce a safe answer for.
 *
 * @param {*} value
 * @returns {string}
 */
function isSchemeChar(ch) {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '+' ||
    ch === '.' ||
    ch === '-'
  );
}

function redactCredentials(value) {
  const str = String(value);
  // indexOf is a single linear scan; only once "://" is actually found does
  // the (bounded) backward walk for the scheme name run. A regex trying to
  // match a scheme at every position of a long string with no "://" at all
  // backtracks quadratically — confirmed by hand: 4M 'a' characters hung
  // for minutes under `/([a-zA-Z][a-zA-Z0-9+.-]*):\/\//`. This shape can't
  // do that: worst case is one linear scan plus one bounded walk.
  const idx = str.indexOf('://');
  if (idx === -1) return str;

  let start = idx;
  while (start > 0 && isSchemeChar(str[start - 1])) start--;
  const scheme = str.slice(start, idx);
  const first = scheme.charCodeAt(0);
  const startsWithLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!scheme || !startsWithLetter) return str; // "://" with no real scheme before it isn't a URL

  return `${scheme}://<redacted>`;
}

/**
 * Reject a configured value that is evidently not a filesystem path — a
 * `<scheme>://` connection string (postgresql://, postgres://, mysql://,
 * sqlite://, ...). A plain filesystem path never contains "://", so this
 * never catches a legitimate path — including one containing ':' or '@'
 * elsewhere, e.g. `/tmp/a@b/x.db`.
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
  if (URL_SCHEME_RE.test(value)) {
    const label = varName || 'the configured database path';
    throw new NotAFilesystemPathError(
      `${label} is not a filesystem path: "${redactCredentials(value)}" looks like a ` +
        `<scheme>:// connection string. Expected a SQLite file path (e.g. ./data/voiceagent.db).`
    );
  }
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
  resolveConfiguredDbPath,
  NotAFilesystemPathError,
};
