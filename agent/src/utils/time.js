'use strict';

/**
 * spec: .superpowers/sdd/scheduler/task-1-brief.md
 *
 * Timezone-aware slot-time helpers. `dose_events.slot_time` is stored as
 * ISO-8601 UTC, but a medication's `times` are local "HH:MM" strings in
 * the patient's own timezone. These are the only functions allowed to
 * cross that boundary, and they do it with Intl.DateTimeFormat +
 * formatToParts — never a hardcoded offset, because the offset is a
 * per-patient fact and, for a zone with DST, a per-date fact too.
 */

/**
 * The UTC offset, in minutes, of `timeZone` at the instant `utcDate`
 * represents. Positive east of UTC (e.g. Asia/Kolkata is +330).
 *
 * @param {Date} utcDate
 * @param {string} timeZone - IANA zone name
 * @returns {number} offset in minutes
 */
function offsetMinutesAt(utcDate, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcDate);

  const get = (type) => parts.find((p) => p.type === type).value;
  // Reinterpret the wall-clock time the zone shows for this UTC instant as
  // if it were itself UTC, then diff against the real instant — the
  // difference is exactly the zone's offset at that moment.
  const asUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second'))
  );
  return Math.round((asUtc - utcDate.getTime()) / 60000);
}

/**
 * A local wall-clock date+time in `timeZone`, converted to the UTC instant
 * it represents.
 *
 * @param {string} dateOnly - "YYYY-MM-DD", local to timeZone
 * @param {string} hhmm - "HH:MM", local to timeZone
 * @param {string} timeZone - IANA zone name
 * @returns {string} ISO-8601 UTC, e.g. "2026-08-30T02:30:00.000Z"
 */
function localSlotToUtc(dateOnly, hhmm, timeZone) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);

  // First pass: treat the wall-clock numbers as if they were UTC, then
  // correct by the zone's offset at that guess. A second pass re-reads the
  // offset at the corrected instant — that's what keeps this right across
  // a DST transition, where the offset at the naive guess can differ from
  // the offset at the true instant.
  //
  // Two edge cases fall out of this and are deliberate, not accidental:
  //
  // - Spring-forward gap (a local time that never occurs, e.g. 02:30 on
  //   the day clocks jump from 02:00 to 03:00): the final subtraction uses
  //   refinedOffset, which is read AFTER the correction, so it lands on
  //   the post-transition offset. The result is a real UTC instant, but
  //   converting it back with utcToLocalParts will not reproduce the
  //   requested hhmm — that local time was never realizable, so there is
  //   no offset that round-trips it.
  //   Verified: localSlotToUtc('2026-03-08', '02:30', 'America/New_York')
  //   -> '2026-03-08T06:30:00.000Z' (the EDT/post-transition offset).
  //
  // - Fall-back ambiguity (a local time that occurs twice, e.g. 01:30 on
  //   the day clocks fall from 02:00 back to 01:00): guessOffset is read
  //   at the naive (pre-correction) instant, which — for every zone this
  //   codebase uses — falls on the pre-transition side, so this resolves
  //   to the EARLIER of the two occurrences and refinedOffset confirms it
  //   (no second correction needed).
  //   Verified: localSlotToUtc('2026-11-01', '01:30', 'America/New_York')
  //   -> '2026-11-01T05:30:00.000Z' (the EDT/first-occurrence offset).
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guessOffset = offsetMinutesAt(new Date(naiveUtc), timeZone);
  const firstPass = naiveUtc - guessOffset * 60000;
  const refinedOffset = offsetMinutesAt(new Date(firstPass), timeZone);
  const utcMillis = naiveUtc - refinedOffset * 60000;

  return new Date(utcMillis).toISOString();
}

/**
 * The reverse of localSlotToUtc: an ISO-8601 UTC instant, expressed as
 * wall-clock date and time in `timeZone`.
 *
 * @param {string} iso - ISO-8601 UTC instant
 * @param {string} timeZone - IANA zone name
 * @returns {{dateOnly: string, hhmm: string}}
 */
function utcToLocalParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dateOnly: `${get('year')}-${get('month')}-${get('day')}`,
    hhmm: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Whether a UTC instant falls inside a local "HH:MM"-"HH:MM" window in
 * `timeZone`. Handles a window that crosses midnight (e.g. 22:00-06:00):
 * when `end` is earlier than `start`, the window is read as the union of
 * [start, 24:00) and [00:00, end], not the empty same-day range.
 *
 * @param {string} iso - ISO-8601 UTC instant
 * @param {{start: string, end: string}} window - local "HH:MM" bounds
 * @param {string} timeZone - IANA zone name
 * @returns {boolean}
 */
function isWithinLocalWindow(iso, { start, end }, timeZone) {
  const { hhmm } = utcToLocalParts(iso, timeZone);
  const toMinutes = (hm) => {
    const [h, m] = hm.split(':').map(Number);
    return h * 60 + m;
  };
  const t = toMinutes(hhmm);
  const s = toMinutes(start);
  const e = toMinutes(end);

  if (s <= e) {
    return t >= s && t <= e;
  }
  // Crosses midnight: inside if at/after start, or at/before end.
  return t >= s || t <= e;
}

module.exports = { localSlotToUtc, utcToLocalParts, isWithinLocalWindow };
