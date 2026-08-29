'use strict';

/**
 * Structured JSON Logger
 *
 * Emits structured JSON log lines for observability and log aggregation.
 * Every log line includes an event name and ISO timestamp.
 */

/**
 * Log an event as structured JSON to stdout.
 *
 * @param {string} event - Event name (e.g., 'server_start', 'stt_connect')
 * @param {Object} [data={}] - Additional data to include in the log entry
 */
function log(event, data = {}) {
  console.log(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...data,
    })
  );
}

/**
 * Log an error as structured JSON to stderr.
 *
 * @param {string} event - Event name
 * @param {Error|Object|string} error - Error object or message
 * @param {Object} [data={}] - Additional context
 */
function error(event, error, data = {}) {
  console.error(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
      ...data,
    })
  );
}

module.exports = { log, error };
