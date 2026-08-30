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
// Anchored at both ends: the whole prefix, or nothing. Deterministic, so it
// is linear in the prefix length however long that prefix is.
const CLEAN_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

class NotAFilesystemPathError extends Error {}

/**
 * Redact a value before it reaches a log line or an error message. db_path is
 * meant to be a SQLite filesystem path, but DB_PATH, DATABASE_URL and
 * VOXIKIN_DB have all been seen set to a Postgres connection string by
 * mistake — logging or throwing one verbatim would put the password in the
 * log or in the crash report.
 *
 * Exactly two rules, and there is no third:
 *
 *   - the value contains "://" anywhere -> coarsen it. No character after
 *     the "://" survives, and what precedes it survives only when it is
 *     itself a clean scheme name — so "1abc://user:pw@host", whose prefix is
 *     really a mis-split credential, comes out "<redacted>://<redacted>".
 *   - it does not -> return it byte-identical, not even copied through a
 *     regex, so a real path can never be corrupted into pointing at the
 *     wrong database.
 *
 * Four earlier rounds each added a third rule — extract just the userinfo,
 * scope to the authority, bail out when the prefix isn't a valid scheme —
 * and every one of those decisions was a place a credential slipped through,
 * the last returning the connection string verbatim. Any condition that can
 * return the original while "://" is present is that bug again.
 *
 * Never throws on any input — null, undefined, a number, empty string, a
 * lone "://", a null byte, unicode, whitespace padding, multi-megabyte:
 * String() tolerates all of it, and indexOf, slice and test cannot throw.
 *
 * No ReDoS: indexOf is one linear scan, and the scheme test runs only once
 * "://" has been found, anchored at both ends over the prefix alone. It
 * cannot retry at every position the way `/([a-zA-Z][a-zA-Z0-9+.-]*):\/\//`
 * does — that shape hung for minutes on 4M characters containing no "://".
 *
 * @param {*} value
 * @returns {string}
 */
function redactCredentials(value) {
  const str = String(value);
  const idx = str.indexOf('://');
  if (idx === -1) return str;
  const prefix = str.slice(0, idx);
  return `${CLEAN_SCHEME_RE.test(prefix) ? prefix : '<redacted>'}://<redacted>`;
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
