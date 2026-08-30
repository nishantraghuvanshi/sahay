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

// "kha liya" / "खा लिया" are deliberately absent. They mean "ate", and only
// ever meant "took the tablet" by accident of context — an accident the food
// question removed. On a real v15 call the agent asked "क्या आपने खाना खा
// लिया है?", the caller answered about food, report_outcome never fired
// because they hung up, and this list read the answer as a dose confirmation:
// the call was persisted CONFIRMED for a dose that was never taken.
//
// A false CONFIRMED writes "dose taken" into a caregiver's record and is the
// worst thing this system can get wrong quietly. A missed confirmation merely
// falls through to a weaker outcome, which someone can still act on.
const CONFIRMED_KEYWORDS = [
  // Romanized
  'haan', 'haa', 'le liya', 'ho gaya', 'li hai', 'liya hai',
  // Devanagari
  'हां', 'हाँ', 'ले लिया', 'हो गया',
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
 *
 * The English stems below cover the same emergency categories the
 * report_outcome tool enumerates (see tools.js): chest pain, difficulty
 * breathing, severe dizziness, fainting, bleeding, a fall, sudden weakness,
 * slurred speech, severe pain, confusion. The product is Hinglish
 * code-switching, so a caller reporting an emergency in English must
 * escalate exactly like one reporting it in Hindi.
 *
 * Multi-word phrases (e.g. "chest pain" rather than bare "chest"/"pain")
 * are used wherever a bare word would sit next to a common English
 * negator — isNegated() below only checks the SINGLE word immediately
 * before a match, so "no chest pain" only negates correctly if "chest
 * pain" is matched as one unit; matching bare "pain" would see "chest",
 * not "no", as the preceding word and fail to suppress it.
 */
const SYMPTOM_KEYWORDS = [
  // Romanized
  'dard', 'bukhar', 'ulti', 'chakkar',
  'saans', 'seene', 'behosh', 'kamzori', 'gir gaya', 'gir gayi',
  // Devanagari
  'दर्द', 'बुखार', 'उल्टी', 'चक्कर',
  'साँस', 'सांस', 'सीने', 'बेहोश', 'कमज़ोरी', 'कमजोरी', 'गिर गया', 'गिर गयी',
  // English
  'chest pain', 'difficulty breathing', 'trouble breathing',
  "can't breathe", 'cant breathe', 'cannot breathe', 'shortness of breath',
  'dizzy', 'dizziness', 'faint', 'bleeding', 'blood', 'fell', 'fall',
  'weak', 'slurred', 'slurring', 'confused', 'confusion',
  'severe pain', 'a lot of pain',
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

  // English. This list was Hindi plus one narrow Hinglish transliteration, so
  // "I want to end my life" and even "mujhe marna hai" both derived NO_ANSWER —
  // a suicidal caller classified as nobody having answered the phone. A false
  // positive costs a caregiver one unnecessary call; a false negative costs the
  // thing this system exists to prevent.
  'want to die', 'wanna die', 'end my life', 'end it all', 'kill myself',
  'hurt myself', 'harm myself', 'no reason to live', "don't want to live",
  'dont want to live', 'do not want to live', 'not worth living',
  'give up on treatment', 'giving up on treatment', 'stop the treatment',
  'stop taking everything', 'stop all my medicines', 'stop my medicines',

  // Wider Hinglish — the same intents in the forms people actually say,
  // including the short imperative ones the original list missed.
  'marna hai', 'mar jaunga', 'mar jaungi', 'mar jana chahta',
  'jeene ka mann nahi', 'jeena nahi chahta hoon', 'jeena nahi chahti hoon',
  'zinda nahi rehna', 'khatam kar dena chahta', 'khud ko khatam',
  'dawai band kar dunga', 'dawai band kar dungi', 'ilaj band kar dunga',
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
