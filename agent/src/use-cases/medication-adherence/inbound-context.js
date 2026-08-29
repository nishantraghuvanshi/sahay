'use strict';

/**
 * Turn a resolved inbound call into prompt variables.
 *
 * Lives in the use case rather than core because the wording is both
 * language-specific and use-case-specific — core/ resolves facts, this
 * composes sentences.
 */

/**
 * Intake fields, in the order they are asked.
 *
 * Order matters: `missing_field` is the FIRST unanswered one, so a resumed
 * call continues exactly where it stopped instead of starting over.
 */
const INTAKE_FIELDS = [
  { key: 'chief_complaint', hi: 'क्या तकलीफ़ है', en: 'what is troubling you' },
  { key: 'onset', hi: 'यह कब से है', en: 'when it started' },
  { key: 'breathing', hi: 'साँस लेने में दिक्कत तो नहीं', en: 'whether your breathing feels normal' },
  { key: 'who_is_with_you', hi: 'अभी आपके पास कौन है', en: 'who is with you right now' },
];

/**
 * Fallback address when we have no name yet.
 *
 * Empty in Hindi: the templates already append the honorific "जी", so any
 * placeholder value here produces "नमस्ते जी जी". The leftover gap is closed
 * by the first-message tidy pass in the strategy.
 */
const FALLBACK_NAME = { hi: '', en: 'there' };
const FALLBACK_CAREGIVER = { hi: 'आपके परिवार', en: 'your family' };

/**
 * @param {Object} resolution - Output of resolveInboundCall()
 * @param {string} [language=hi]
 * @returns {Object} Variables for buildSystemPrompt / buildFirstMessage
 */
function buildInboundVariables(resolution, language = 'hi') {
  const lang = language === 'en' ? 'en' : 'hi';
  const patient = resolution.patient || {};

  return {
    parent_name: patient.name || FALLBACK_NAME[lang],
    drug_name: patient.drug_name || '',
    caregiver_name: patient.caregiver_name || FALLBACK_CAREGIVER[lang],
    context_line: buildContextLine(resolution, lang),
    fields_summary: buildFieldsSummary(resolution.fieldsSoFar, lang),
    missing_field: firstMissingField(resolution.fieldsSoFar, lang),
  };
}

/**
 * The half-sentence that proves the caller was recognised.
 *
 * Empty for a caller we genuinely do not know — an agent that implies
 * familiarity it does not have is worse than one that simply greets.
 *
 * @private
 */
function buildContextLine(resolution, lang) {
  if (resolution.isNewPatient || !resolution.patient) return '';

  const last = (resolution.lastCalls || [])[0];
  if (!last) return '';

  // Reference that a previous call happened, without restating a clinical
  // claim we would then be asserting. The reason field is our own label,
  // not the caller's words, so it is not repeated back as if quoted.
  if (last.outcome_label === 'ESCALATED_SYMPTOM' || last.outcome_label === 'ESCALATED_DISTRESS') {
    return lang === 'hi'
      ? 'पिछली बार आपने तबीयत की बात की थी। '
      : 'Last time you mentioned not feeling well. ';
  }

  return lang === 'hi' ? 'हमने पिछली बार बात की थी। ' : 'We spoke last time. ';
}

/**
 * What is already held, repeated back verbatim.
 *
 * Values are the caller's own words and are never paraphrased — the point of
 * resume is that they hear their own answer, not a summary of it.
 *
 * @private
 */
function buildFieldsSummary(fieldsSoFar = {}, lang) {
  const parts = INTAKE_FIELDS.filter((f) => hasValue(fieldsSoFar[f.key])).map(
    (f) => String(fieldsSoFar[f.key])
  );

  if (parts.length === 0) return '';
  return parts.join(lang === 'hi' ? ', ' : ', ');
}

/**
 * The first field still unanswered, as a phrase the prompt can ask.
 * Empty when nothing is missing.
 * @private
 */
function firstMissingField(fieldsSoFar = {}, lang) {
  const next = INTAKE_FIELDS.find((f) => !hasValue(fieldsSoFar[f.key]));
  return next ? next[lang] : '';
}

/** @private */
function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

module.exports = {
  buildInboundVariables,
  INTAKE_FIELDS,
};
