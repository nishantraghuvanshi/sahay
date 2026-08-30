'use strict';

const {
  buildNextCallLine,
  foodRelationForSlot,
  collectSlots,
  currentSlotAt,
} = require('./next-call');

/**
 * The per-call variables that come from the patient's own schedule rather than
 * from whoever placed the call.
 *
 * Both outbound entrypoints (`POST /api/call` and `scripts/make-call.js`) go
 * through here, so a call placed by hand carries the same context a scheduled
 * one does. Everything is precomputed: the agent is never asked to work out
 * when the next dose is or how a medicine relates to food, because a model
 * inventing "मैं आपको 9 बजे कॉल करूँगी" when nothing is scheduled is the same
 * defect as claiming to have contacted the family.
 *
 * Every value is a string, always present, empty when it must not be said.
 * Empty renders as silence: the prompt branches on emptiness.
 */

// Repeating the prescription's own food instruction is allowed — the guardrail
// draws the line at CHANGING the plan, not at restating it. These say what the
// prescription says and nothing more; none of them tells the patient when to
// eat, which would be constructing a schedule.
const FOOD_QUESTION = 'क्या आपने खाना खा लिया है?';

const FOOD_LINES = {
  after: 'यह दवाई खाने के बाद लेनी होती है।',
  before: 'यह दवाई खाने से पहले लेनी होती है।',
  with: 'यह दवाई खाने के साथ लेनी होती है।',
};

/**
 * What to say when they answer that they have NOT eaten.
 *
 * Without these the call walked into a contradiction of its own making: it
 * read out "यह दवाई खाने के बाद लेनी होती है", heard "मैंने खाना नहीं खाया",
 * and still asked "क्या आप अभी ले लेंगे?" — telling someone to take an
 * after-food medicine on an empty stomach. Asked how, it fell back on "मैं
 * medical advice नहीं दे सकती" and asked again, in a loop.
 *
 * Each line is the same prescription relation the food line already stated,
 * applied to what they just said. Nothing new is prescribed: an after-food
 * medicine waits for the food, a before-food one can be taken now.
 */
const FOOD_WAIT_LINES = {
  after: 'तो खाना खाने के बाद ले लीजियेगा।',
  before: 'तो अभी ले लीजिये, खाने से पहले।',
  with: 'तो खाने के साथ ले लीजियेगा।',
};

/**
 * @param {Object} params
 * @param {Object} params.repository - must implement findPatientByPhone and
 *   findMedicationsForPatient; a repository without a database returns nothing
 *   and every line comes back empty, which is the safe outcome.
 * @param {string} params.phone - E.164
 * @param {string} [params.slot] - "HH:MM" this call is about. When absent it
 *   is derived from `nowHHMM`: a call placed by hand at 08:45 is about the
 *   08:30 dose, not the 21:00 one.
 * @param {string} [params.nowHHMM] - local "HH:MM" at the patient
 * @returns {Promise<{next_call_line: string, food_question: string, food_line: string, food_wait_line: string}>}
 */
async function buildScheduleVariables({ repository, phone, slot, nowHHMM } = {}) {
  const empty = { next_call_line: '', food_question: '', food_line: '', food_wait_line: '' };
  if (!repository || !phone || (!slot && !nowHHMM)) return empty;

  let patient;
  let medications;
  try {
    patient = await repository.findPatientByPhone(phone);
    if (!patient) return empty;
    medications = await repository.findMedicationsForPatient(patient.id);
  } catch {
    // A schedule lookup must never stop a dose call going out. Losing the
    // next-call sentence is a small loss; losing the call is the product.
    return empty;
  }

  if (!medications || medications.length === 0) return empty;

  const effectiveSlot = slot || currentSlotAt(collectSlots(medications), nowHHMM);
  // Before the first dose of the day there is no slot this call is about, so
  // there is nothing honest to say about food. The next-call line is still
  // computed from the clock, since the next dose is genuinely ahead.
  const relation = effectiveSlot ? foodRelationForSlot(medications, effectiveSlot) : null;

  return {
    next_call_line: buildNextCallLine({
      medications,
      afterSlot: effectiveSlot || nowHHMM,
      mealTimes: patient.meal_times,
    }),
    // Both empty together: the prompt carries no food wording of its own, so
    // an absent rule means the agent has nothing about food to say and no
    // words to borrow.
    food_question: relation ? FOOD_QUESTION : '',
    food_line: (relation && FOOD_LINES[relation]) || '',
    food_wait_line: (relation && FOOD_WAIT_LINES[relation]) || '',
  };
}

module.exports = { buildScheduleVariables, FOOD_LINES, FOOD_QUESTION, FOOD_WAIT_LINES };
