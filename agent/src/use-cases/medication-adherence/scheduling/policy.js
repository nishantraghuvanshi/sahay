'use strict';

/**
 * spec: .superpowers/sdd/scheduler/task-3-brief.md
 *
 * The dial decision: given one due dose event, say whether to dial it now,
 * skip it, wait, or give up — and why. Pure, ordered, first match wins. No
 * I/O, no clock read, no model call, no mutation. The caller — a
 * scheduling loop, not written here — supplies `now` and `activeSession`;
 * this module never looks either up itself.
 *
 * The `reason` on every branch is rendered to a caregiver and is this
 * system's audit trail. It describes what was observed, never what it
 * means — the same discipline `rules/priority.js` uses for the call: a
 * rule string never carries an interpretation, only the fact that fired it.
 */

const { isWithinLocalWindow } = require('../../../utils/time');

/**
 * Minutes after the slot time for each retry. Measured from slot_time
 * itself, not from the previous attempt: the first retry is slot+5min, the
 * second slot+15, the third slot+30.
 */
const RETRY_OFFSETS_MIN = [5, 15, 30];

/**
 * The initial slot-time dial plus every retry offset. Derived from
 * RETRY_OFFSETS_MIN, never written as a second literal — two literals
 * drift.
 */
const MAX_ATTEMPTS = RETRY_OFFSETS_MIN.length + 1;

/**
 * When the next attempt for a dose becomes eligible, given the attempt
 * count just recorded. attempt_count 1 is the slot-time dial itself, so it
 * maps to the first retry offset (index 0); attempt_count MAX_ATTEMPTS has
 * no further offset to map to — there is no fifth dial.
 *
 * @param {string} slotTime - ISO-8601 UTC
 * @param {number} attemptCount - 1-based count of attempts made so far
 * @returns {string|null} ISO-8601 UTC, or null when no further attempt is due
 */
function nextAttemptAt(slotTime, attemptCount) {
  const offsetMin = RETRY_OFFSETS_MIN[attemptCount - 1];
  if (offsetMin == null) return null;
  return new Date(new Date(slotTime).getTime() + offsetMin * 60_000).toISOString();
}

/** "HH:MM", 24-hour, the same shape medications.times and quiet windows use throughout. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether a single parsed quiet-window element is usable: a non-null
 * object whose `start` and `end` are both "HH:MM" strings. Rejecting a
 * shape isWithinLocalWindow can't safely evaluate — a missing `end`, a
 * non-object entry, a non-string bound — here, at the parse boundary, is
 * what keeps that already-reviewed, already-tested helper's contract
 * (`{start, end}` are well-formed "HH:MM" strings) intact rather than
 * teaching it to re-validate what every other caller already guarantees.
 *
 * @param {*} window
 * @returns {boolean}
 */
function isValidQuietWindow(window) {
  return (
    window !== null &&
    typeof window === 'object' &&
    typeof window.start === 'string' &&
    typeof window.end === 'string' &&
    HHMM_RE.test(window.start) &&
    HHMM_RE.test(window.end)
  );
}

/**
 * Parses patients.quiet_windows, a raw JSON string handed through
 * unparsed, exactly like medications.times. Null, empty, and malformed
 * values all resolve to "no quiet windows" rather than throwing: a patient
 * row whose quiet-window setting cannot be read must still be dialable,
 * because the alternative — one bad row silently stopping every future
 * medication call for that patient — is worse than ignoring a setting that
 * could not be read.
 *
 * The same discipline applies one level deeper: a malformed *element*
 * inside an otherwise well-formed array (a dropped `end`, a `null` entry)
 * is dropped rather than crashing the whole array or discarding every
 * window the patient configured. A caregiver who set a good 06:00-07:00
 * window and a corrupted second entry keeps the good window.
 *
 * @param {string|null|undefined} raw
 * @returns {Array<{start: string, end: string}>}
 */
function parseQuietWindows(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidQuietWindow);
  } catch {
    return [];
  }
}

/**
 * Whether `now` falls inside any of the patient's quiet windows, in the
 * patient's own timezone.
 *
 * @param {Object} patient - a patients row
 * @param {Date} now
 * @returns {boolean}
 */
function isInsideQuietWindow(patient, now) {
  const windows = parseQuietWindows(patient.quiet_windows);
  const iso = now.toISOString();
  return windows.some((window) => isWithinLocalWindow(iso, window, patient.timezone));
}

/**
 * The dial decision for one due dose event. See task-3-brief.md for the
 * exact rule order and reason strings — matched verbatim here, first match
 * wins.
 *
 * @param {Object} args
 * @param {Object} args.doseEvent - a dose_events row
 * @param {Object} args.medication - a medications row
 * @param {Object} args.patient - a patients row
 * @param {Date} args.now - injected clock
 * @param {*} args.activeSession - truthy when this patient already has a live call
 * @returns {{dial: boolean, action: 'dial'|'skip'|'wait'|'give_up', reason: string}}
 */
function decideDial({ doseEvent, medication, patient, now, activeSession }) {
  if (patient.schedule_signed_off_at == null) {
    return { dial: false, action: 'skip', reason: 'rule: schedule not signed off by caregiver' };
  }

  if (doseEvent.status !== 'pending') {
    return {
      dial: false,
      action: 'skip',
      reason: `rule: dose already resolved as ${doseEvent.status}`,
    };
  }

  if (activeSession) {
    return { dial: false, action: 'wait', reason: 'rule: patient already on a live call' };
  }

  if (doseEvent.attempt_count >= MAX_ATTEMPTS) {
    return {
      dial: false,
      action: 'give_up',
      reason: 'rule: three retries made without an answer',
    };
  }

  if (doseEvent.next_attempt_at != null && new Date(doseEvent.next_attempt_at) > now) {
    return {
      dial: false,
      action: 'wait',
      reason: `rule: next attempt not due until ${doseEvent.next_attempt_at}`,
    };
  }

  if (isInsideQuietWindow(patient, now)) {
    if (!medication.is_priority) {
      return { dial: false, action: 'skip', reason: 'rule: inside caregiver do-not-call window' };
    }
    return {
      dial: true,
      action: 'dial',
      reason: 'rule: priority medication overrides do-not-call window',
    };
  }

  return { dial: true, action: 'dial', reason: 'rule: dose time reached' };
}

module.exports = { decideDial, nextAttemptAt, RETRY_OFFSETS_MIN, MAX_ATTEMPTS };
