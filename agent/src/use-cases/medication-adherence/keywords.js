'use strict';

/**
 * Hindi keyword lists for outcome derivation fallback.
 *
 * Both Romanized and Devanagari forms are included.
 * Adapted from voiceagent01's proven keyword lists.
 *
 * Priority in keyword matching: symptom > confirmed > denied
 * (so "haan le liya lekin bukhar bhi hai" escalates, not confirms)
 */

const CONFIRMED_KEYWORDS = [
  // Romanized
  'haan', 'haa', 'le liya', 'ho gaya', 'kha liya', 'li hai', 'liya hai',
  // Devanagari
  'हां', 'हाँ', 'ले लिया', 'हो गया', 'खा लिया',
];

const DENIED_KEYWORDS = [
  // Romanized
  'nahi', 'nahin', 'abhi nahi',
  // Devanagari
  'नहीं', 'अभी नहीं',
];

/**
 * Symptom stems that trigger ESCALATED_SYMPTOM.
 *
 * Includes the emergency-relevant terms (breathing, chest, fainting, falls)
 * that the original four-stem list missed — those are the presentations
 * where a delayed response actually costs something.
 */
const SYMPTOM_KEYWORDS = [
  // Romanized
  'dard', 'bukhar', 'ulti', 'chakkar',
  'saans', 'seene', 'behosh', 'kamzori', 'gir gaya', 'gir gayi',
  // Devanagari
  'दर्द', 'बुखार', 'उल्टी', 'चक्कर',
  'साँस', 'सांस', 'सीने', 'बेहोश', 'कमज़ोरी', 'कमजोरी', 'गिर गया', 'गिर गयी',
];

/**
 * Distress stems that trigger ESCALATED_DISTRESS — separate from
 * SYMPTOM_KEYWORDS because a medical emergency and emotional distress get
 * different (and differently urgent) responses. Kept as multi-word phrases
 * rather than single stems, since a bare stem like "जीना" (to live) only
 * signals distress in combination with a negation, and matching on the full
 * phrase avoids re-running that negation logic against itself.
 */
const DISTRESS_KEYWORDS = [
  // Romanized
  'marna chahta hoon', 'marna chahti hoon', 'jeena nahi chahta', 'jeena nahi chahti',
  'jeene ka man nahi', 'khud ko nuksan', 'atmahatya',
  'dawai band karna chahta hoon', 'dawai band karna chahti hoon',
  'ilaj band karna chahta hoon', 'ilaj band karna chahti hoon',
  // Devanagari
  'मरना चाहता हूँ', 'मरना चाहती हूँ', 'जीना नहीं चाहता', 'जीना नहीं चाहती',
  'जीने का मन नहीं', 'खुद को नुकसान', 'आत्महत्या',
  'दवाई बंद करना चाहता हूँ', 'दवाई बंद करना चाहती हूँ',
  'इलाज बंद करना चाहता हूँ', 'इलाज बंद करना चाहती हूँ',
];

/**
 * Negation tokens that FOLLOW the thing being negated.
 *
 * Hindi negation is post-positional — "दर्द नहीं है" (pain not is). A trailing
 * window is therefore the correct place to look, and crucially it avoids
 * misreading "nahi liya, dard bahut hai" (didn't take it, but lots of pain)
 * as a negated symptom.
 */
const NEGATION_AFTER = ['नहीं', 'नही', 'nahi', 'nahin'];

/**
 * Negation tokens that PRECEDE the thing being negated (English word order).
 * Matched against the immediately preceding word only, so "no pain" negates
 * but "not taken it yet, chest hurts" does not.
 */
const NEGATION_BEFORE = ['no', 'not', 'never', 'without'];

/**
 * Symptom stems that negation must NEVER suppress.
 *
 * Negation suppression assumes a symptom is bad when PRESENT ("दर्द नहीं" = fine).
 * Breathing inverts that: "साँस नहीं आ रही" (breath is not coming) is respiratory
 * distress — the negation makes it an emergency, not a reassurance.
 *
 * A false positive here costs a phone call. A false negative costs far more,
 * so these stems escalate on any mention.
 */
const NEGATION_EXEMPT_KEYWORDS = ['साँस', 'सांस', 'saans', 'बेहोश', 'behosh'];

module.exports = {
  CONFIRMED_KEYWORDS,
  DENIED_KEYWORDS,
  SYMPTOM_KEYWORDS,
  DISTRESS_KEYWORDS,
  NEGATION_AFTER,
  NEGATION_BEFORE,
  NEGATION_EXEMPT_KEYWORDS,
};
