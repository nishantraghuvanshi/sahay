'use strict';

/**
 * What the agent can honestly say about the NEXT dose call, and whether the
 * dose it is calling about cares about food.
 *
 * Pure: no clock, no I/O, no model call. Everything comes from rows the
 * caller already read — `medications.slots`, `medications.with_food` and
 * `patients.meal_times`. The agent is never asked to work any of this out
 * itself, for two reasons. It would cost a turn's worth of reasoning on every
 * call, and a model inventing "मैं आपको 9 बजे कॉल करूँगी" when nothing is
 * scheduled is the same defect as claiming to have contacted the family — a
 * promise to a patient that nobody is going to keep.
 *
 * @see docs/superpowers/specs/2026-08-30-elevenlabs-outbound-transport-design.md
 */

/** Hindi word for the part of the day a 24h hour falls in. */
function periodOfDay(hour24) {
  if (hour24 >= 4 && hour24 < 12) return 'सुबह';
  if (hour24 >= 12 && hour24 < 16) return 'दोपहर';
  if (hour24 >= 16 && hour24 < 19) return 'शाम';
  return 'रात';
}

/** "21:00" -> {h:21, m:0, minutes:1260}; null when unparseable. */
function parseSlot(slot) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min, minutes: h * 60 + min };
}

/**
 * Medicines that are still being taken. A stopped or excluded row must not
 * put a slot on the schedule — the patient would be told about a call that
 * will never come, or asked about a medicine they were taken off.
 */
function isActive(med) {
  return !med.stopped_at && !med.excluded;
}

/** `slots` is stored as a JSON string but may already be an array. */
function slotsOf(med) {
  const raw = med && med.slots;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A malformed row must not take the call down. Better to lose one
    // medicine's slots than to throw while a patient is on the line.
    return [];
  }
}

/**
 * Every distinct dose time for this patient, sorted.
 * @param {Array<Object>} medications - rows from `medications`
 * @returns {string[]} "HH:MM", ascending, no duplicates
 */
function collectSlots(medications) {
  const seen = new Set();
  for (const med of medications || []) {
    if (!isActive(med)) continue;
    for (const slot of slotsOf(med)) {
      if (parseSlot(slot)) seen.add(String(slot).trim());
    }
  }
  return [...seen].sort((a, b) => parseSlot(a).minutes - parseSlot(b).minutes);
}

/**
 * The next dose time strictly later in the SAME day.
 *
 * Deliberately does not roll over to tomorrow morning. Saying "I will call you
 * tomorrow at eight" commits a scheduler that may not be running, to a day
 * this function knows nothing about. Silence is the honest answer.
 *
 * @returns {string|null}
 */
function nextSlotAfter(slots, afterSlot) {
  const after = parseSlot(afterSlot);
  if (!after) return null;
  for (const slot of slots || []) {
    const parsed = parseSlot(slot);
    if (parsed && parsed.minutes > after.minutes) return slot;
  }
  return null;
}

// Strictest first: if any medicine at a slot needs food, the food question is
// worth asking, even when another at the same slot does not care.
const FOOD_PRECEDENCE = ['before', 'after', 'with'];

/**
 * How the medicines due at one slot relate to food.
 * @returns {'before'|'after'|'with'|null} null when none of them care
 */
function foodRelationForSlot(medications, slot) {
  const found = new Set();
  for (const med of medications || []) {
    if (!isActive(med)) continue;
    if (!slotsOf(med).map((s) => String(s).trim()).includes(String(slot).trim())) continue;
    const rel = String(med.with_food || '').toLowerCase();
    if (FOOD_PRECEDENCE.includes(rel)) found.add(rel);
  }
  return FOOD_PRECEDENCE.find((rel) => found.has(rel)) || null;
}

// A dose within this many minutes after a meal is described by that meal
// ("after dinner") rather than by the clock alone. Two hours is wide enough
// for a 20:30 dinner and a 21:00 dose, and narrow enough that a 16:00 dose
// is not called "after lunch".
const MEAL_WINDOW_MIN = 120;

/**
 * The meal a slot sits just after, if any.
 * @param {Object|string|null} mealTimes - patients.meal_times
 * @returns {string|null} Hindi meal name
 */
function mealBefore(slot, mealTimes) {
  const MEAL_NAMES = { breakfast: 'नाश्ते', lunch: 'दोपहर के खाने', dinner: 'रात के खाने' };
  let parsed = mealTimes;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const target = parseSlot(slot);
  if (!target) return null;

  let best = null;
  for (const [key, time] of Object.entries(parsed)) {
    const name = MEAL_NAMES[key];
    if (!name) continue;
    const at = parseSlot(time);
    if (!at) continue;
    const gap = target.minutes - at.minutes;
    if (gap >= 0 && gap <= MEAL_WINDOW_MIN && (!best || gap < best.gap)) {
      best = { name, gap };
    }
  }
  return best ? best.name : null;
}

/** 21 -> 9, 12 -> 12, 0 -> 12. Digits, not Hindi number words: TTS reads them. */
function to12Hour(hour24) {
  const h = hour24 % 12;
  return h === 0 ? 12 : h;
}

/**
 * The sentence the agent says at the end of the call about when it will ring
 * next, or "" when it must not promise anything.
 *
 * @param {Object} params
 * @param {Array<Object>} params.medications
 * @param {string} params.afterSlot - the slot this call is about, "HH:MM"
 * @param {Object|string|null} [params.mealTimes]
 * @returns {string} Hindi sentence, or "" meaning say nothing
 */
function buildNextCallLine({ medications, afterSlot, mealTimes } = {}) {
  const next = nextSlotAfter(collectSlots(medications), afterSlot);
  if (!next) return '';

  const parsed = parseSlot(next);
  const clock = `${to12Hour(parsed.h)} बजे`;
  const meal = mealBefore(next, mealTimes);

  return meal
    ? `मैं आपको ${meal} के बाद, ${clock} फिर कॉल करूँगी।`
    : `मैं आपको ${periodOfDay(parsed.h)} ${clock} फिर कॉल करूँगी।`;
}

/**
 * The slot a call placed at `nowHHMM` is about: the most recent dose time at
 * or before now. Used when a caller does not name a slot explicitly — a call
 * placed by hand at 08:45 is about the 08:30 dose, not the 21:00 one.
 *
 * Returns null before the first dose of the day, when the call is not about
 * any slot yet and there is nothing honest to say about food.
 *
 * @returns {string|null}
 */
function currentSlotAt(slots, nowHHMM) {
  const now = parseSlot(nowHHMM);
  if (!now) return null;
  let best = null;
  for (const slot of slots || []) {
    const parsed = parseSlot(slot);
    if (parsed && parsed.minutes <= now.minutes) best = slot;
  }
  return best;
}

module.exports = {
  collectSlots,
  currentSlotAt,
  nextSlotAfter,
  foodRelationForSlot,
  buildNextCallLine,
  // exported for tests and for callers that want the parts
  periodOfDay,
  mealBefore,
};
