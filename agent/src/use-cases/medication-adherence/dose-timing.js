'use strict';

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

module.exports = { buildDoseTiming, MEALS, RELATIONS };
