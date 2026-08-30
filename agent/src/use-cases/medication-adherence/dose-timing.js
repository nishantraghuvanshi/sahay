'use strict';

const { FOOD_LINES, FOOD_QUESTION, FOOD_WAIT_LINES } = require('./scheduling/call-variables');

/**
 * Meal-relative dose timing, as a phrase a prompt can drop into a sentence.
 *
 * Lives in the use case, not in core/ or the playground, for the same reason
 * inbound-context.js does: this is Hindi (and English) wording for one use
 * case's medication schedule, and neither the transport nor the call
 * lifecycle has any business composing it.
 *
 * "after lunch" is not decoration. A reminder that names the meal is the one
 * an elderly listener can act on without doing arithmetic against a clock,
 * and it is the difference between a call that says "your medicine" and one
 * that sounds like it knows their day.
 */

/** The meal words, per language. Keys are what the API and the app both send. */
const MEALS = {
  breakfast: { hi: 'नाश्ते', en: 'breakfast' },
  lunch: { hi: 'दोपहर के खाने', en: 'lunch' },
  dinner: { hi: 'रात के खाने', en: 'dinner' },
};

/** Matches app/src/api/types.ts → WithFood, minus 'any' (no meal to name). */
const RELATIONS = ['before', 'after'];

/**
 * Compose the timing phrase.
 *
 * Returns '' for anything incomplete or unrecognised, which is what leaves
 * the first message reading exactly as it did before this variable existed —
 * a half-built phrase ("your Crocin after") is worse than none, and an
 * unknown meal name must never reach the caller as a raw key.
 *
 * @param {Object} args
 * @param {'before'|'after'} [args.mealRelation]
 * @param {'breakfast'|'lunch'|'dinner'} [args.meal]
 * @param {'hi'|'en'} [language=hi]
 * @returns {string} e.g. "after lunch" / "दोपहर के खाने के बाद"
 */
function buildDoseTiming({ mealRelation, meal } = {}, language = 'hi') {
  const lang = language === 'en' ? 'en' : 'hi';
  if (!RELATIONS.includes(mealRelation)) return '';

  const mealWord = MEALS[meal] && MEALS[meal][lang];
  if (!mealWord) return '';

  if (lang === 'en') return `${mealRelation} ${mealWord}`;
  // Hindi puts the relation after the meal: "नाश्ते के बाद", not "बाद नाश्ते".
  return mealRelation === 'before' ? `${mealWord} से पहले` : `${mealWord} के बाद`;
}

/**
 * The food variables the prompt branches on, for a dose whose meal relation
 * was chosen rather than read off a schedule (the playground).
 *
 * The wording is imported, never re-written: `FOOD_LINES` and `FOOD_QUESTION`
 * in scheduling/call-variables.js are the only sentences the agent is allowed
 * to say about food, because they restate a prescription rather than compose
 * one. A second copy here would be a second thing to keep in step with the
 * guardrail, and the guardrail is the reason they exist — a real call once had
 * the agent announce "Metformin खाने के बाद लेनी होती है" for a medicine with
 * no food rule on file at all.
 *
 * Empty for anything unrecognised, and empty for English: the English prompt
 * carries no food placeholders yet (it trails the Hindi one), so there is
 * nothing there to fill and nothing it could say.
 *
 * @param {Object} args
 * @param {'before'|'after'} [args.mealRelation]
 * @param {'hi'|'en'} [language=hi]
 * @returns {{food_question: string, food_line: string, food_wait_line: string}}
 */
function buildFoodVariables({ mealRelation } = {}, language = 'hi') {
  const empty = { food_question: '', food_line: '', food_wait_line: '' };
  if (language === 'en') return empty;
  if (!RELATIONS.includes(mealRelation)) return empty;

  const line = FOOD_LINES[mealRelation];
  if (!line) return empty;

  // All three together or none: the prompt asks the question, says the line,
  // and — when they have not eaten — says what to do instead. A question with
  // no answer behind it is worse than silence, and a food rule with no
  // "then when?" is what left a real call telling someone to take an
  // after-food medicine on an empty stomach.
  return {
    food_question: FOOD_QUESTION,
    food_line: line,
    food_wait_line: FOOD_WAIT_LINES[mealRelation] || '',
  };
}

module.exports = { buildDoseTiming, buildFoodVariables, MEALS, RELATIONS };
