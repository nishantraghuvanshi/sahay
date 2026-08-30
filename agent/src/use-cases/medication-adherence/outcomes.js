'use strict';

const {
  CONFIRMED_KEYWORDS,
  DENIED_KEYWORDS,
  SYMPTOM_KEYWORDS,
  DISTRESS_KEYWORDS,
  NEGATION_AFTER,
  NEGATION_BEFORE,
  NEGATION_EXEMPT_KEYWORDS,
} = require('./keywords');

/**
 * Outcome labels for the medication adherence use case.
 *
 * ESCALATED_SYMPTOM and INCOMPLETE were split out of a single ESCALATED label:
 * a reported symptom is a medical event that pages a caregiver, whereas a
 * clarify loop is a conversation failure that pages nobody. Conflating them
 * made the symptom false-positive rate uncomputable and would have sent
 * medical alerts on comprehension breakdowns.
 *
 * UNCLEAR was likewise split out of DENIED — "I have not taken it" and
 * "we could not understand them" are different facts, and counting the
 * second as the first corrupts the adherence rate.
 *
 * ESCALATED_DISTRESS was split out of ESCALATED_SYMPTOM: a medical emergency
 * (chest pain, a fall, confusion) needs a doctor NOW and a fixed, unhurried
 * reassurance sequence, whereas emotional distress (wanting to stop
 * treatment, self-harm ideation) needs no probing or coping advice, only a
 * gentle close and a caregiver who can call back. Conflating them would have
 * either rushed a person in distress through a "contact your doctor now"
 * script, or under-reacted to a real medical emergency by routing it through
 * a softer close. A stale prompt still emitting the legacy `ESCALATED` label
 * (see normaliseLabel) always normalises to ESCALATED_SYMPTOM, never to
 * ESCALATED_DISTRESS — the safer of the two outcomes is the one silence
 * defaults to.
 */
const OUTCOMES = {
  CONFIRMED: 'CONFIRMED',
  DENIED: 'DENIED',
  UNCLEAR: 'UNCLEAR',
  ESCALATED_SYMPTOM: 'ESCALATED_SYMPTOM',
  ESCALATED_DISTRESS: 'ESCALATED_DISTRESS',
  INCOMPLETE: 'INCOMPLETE',
  NO_ANSWER: 'NO_ANSWER',
  ERROR: 'ERROR',
};

/** Reasons that mark a conversation breakdown rather than a medical event. */
const BREAKDOWN_REASONS = ['clarify_loop_exceeded', 'clarify_loop', 'max_clarify'];

/** Reasons that mark an undeterminable intent rather than a refusal. */
const UNCLEAR_REASONS = ['unclear_response', 'unclear', 'no_intent'];

/**
 * Derive call outcome from Vapi end-of-call report data.
 *
 * Priority chain (highest wins):
 *   1. tool_call     — LLM called report_outcome function tool
 *   2. analysis      — Vapi's built-in call analysis (structured output)
 *   3. keyword_match — Hindi keywords in the CALLER's speech
 *   4. watchdog      — no response / voicemail / unknown
 *
 * @param {Object} callData - { toolCalls, transcript, userTurns, messages, analysis, endedReason }
 * @returns {{ label: string, source: string, reason: string }}
 */
function deriveOutcome(callData) {
  // 1. Tool call (highest priority — most reliable)
  const toolOutcome = checkToolCalls(callData.toolCalls);
  if (toolOutcome) return toolOutcome;

  // 2. Vapi analysis (structured output from Vapi's call analysis)
  const analysisOutcome = checkAnalysis(callData.analysis);
  if (analysisOutcome) return analysisOutcome;

  // 3. Keyword match, scoped to what the caller actually said
  const keywordOutcome = checkKeywords(extractCallerSpeech(callData));
  if (keywordOutcome) return keywordOutcome;

  // 4. Watchdog (fallback)
  return {
    label: OUTCOMES.NO_ANSWER,
    source: 'watchdog',
    reason: callData.endedReason || 'no_signal',
  };
}

/**
 * Map a reported label + reason onto the current label set.
 *
 * Prompt v1 assistants (and any still live in Vapi) emit the pre-split labels.
 * Normalising here means a stale assistant cannot page a caregiver for a
 * clarify loop, without needing every deployed assistant updated first.
 *
 * @private
 */
function normaliseLabel(label, reason) {
  const raw = String(label || '').toUpperCase();
  const why = String(reason || '').toLowerCase();

  if (raw === 'ESCALATED') {
    return BREAKDOWN_REASONS.some((r) => why.includes(r))
      ? OUTCOMES.INCOMPLETE
      : OUTCOMES.ESCALATED_SYMPTOM;
  }
  if (raw === 'DENIED' && UNCLEAR_REASONS.some((r) => why.includes(r))) {
    return OUTCOMES.UNCLEAR;
  }
  return raw;
}

/** @private */
function checkToolCalls(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const reported = [];
  for (const call of toolCalls) {
    const name = call.name || call.function?.name;
    if (name !== 'report_outcome') continue;

    let args = call.arguments || call.function?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { continue; }
    }
    if (!args || !args.outcome) continue;

    const reason = args.reason || 'llm_reported';
    reported.push({
      label: normaliseLabel(args.outcome, reason),
      source: 'tool_call',
      reason,
    });
  }

  if (reported.length === 0) return null;
  if (reported.length === 1) return reported[0];

  // The prompt says to call report_outcome EXACTLY ONCE per call. Agents do
  // not always comply: an ElevenLabs scenario run reported CONFIRMED, then
  // ESCALATED_SYMPTOM once the patient mentioned chest heaviness, then
  // ESCALATED_DISTRESS. Returning the first match — which is what this did —
  // persisted CONFIRMED and no family alert would ever have fired, for a
  // patient reporting chest pain and fear.
  //
  // So an escalation anywhere in the call outranks everything before it, with
  // the medical emergency outranking the distress. Every other case keeps
  // first-wins: that is the existing behaviour, and the agent's first report is
  // normally its considered answer. Only escalations override, because only a
  // missed escalation has a human cost.
  //
  // The ranking runs on the NORMALISED label, not the raw one, so a legacy
  // ESCALATED carrying a clarify-loop reason stays INCOMPLETE and cannot page
  // a caregiver for a conversation that merely broke down (defect D1).
  return (
    reported.find((r) => r.label === OUTCOMES.ESCALATED_SYMPTOM) ||
    reported.find((r) => r.label === OUTCOMES.ESCALATED_DISTRESS) ||
    reported[0]
  );
}

/** @private */
function checkAnalysis(analysis) {
  if (!analysis) return null;
  if (analysis.structuredData?.outcome) {
    const reason = analysis.structuredData.reason || analysis.summary || 'vapi_analysis';
    return {
      label: normaliseLabel(analysis.structuredData.outcome, reason),
      source: 'analysis',
      reason,
    };
  }
  return null;
}

/**
 * Pull out only what the caller said.
 *
 * The agent asks "क्या आपको कोई दर्द है?" in some branches, so matching symptom
 * stems against the whole transcript would escalate on the agent's own words.
 *
 * Accepts, in order of preference:
 *   - callData.userTurns — array of caller utterances (playground)
 *   - callData.messages  — role-tagged turns
 *   - callData.transcript with "User:" / "Customer:" line prefixes (Vapi)
 *   - callData.transcript with no prefixes — treated as caller speech
 *
 * @private
 */
function extractCallerSpeech(callData) {
  if (Array.isArray(callData.userTurns)) {
    return callData.userTurns.join(' ');
  }

  if (Array.isArray(callData.messages)) {
    return callData.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'customer'))
      .map((m) => m.content || m.message || '')
      .join(' ');
  }

  const transcript = callData.transcript;
  if (!transcript || typeof transcript !== 'string') return '';

  const speakerLine = /^\s*(user|customer|caller|ai|assistant|bot|agent)\s*:/i;
  const lines = transcript.split('\n');
  const hasSpeakerPrefixes = lines.some((l) => speakerLine.test(l));
  if (!hasSpeakerPrefixes) return transcript;

  return lines
    .filter((l) => /^\s*(user|customer|caller)\s*:/i.test(l))
    .map((l) => l.replace(/^\s*\w+\s*:/, ''))
    .join(' ');
}

/**
 * True when every mention of `kw` in `text` is negated.
 *
 * One unnegated mention is enough to treat the symptom as real — "बुखार नहीं है
 * लेकिन बहुत दर्द है" must still escalate on the pain.
 *
 * @private
 */
function isNegated(text, kw) {
  // Some stems mean the opposite when negated — see NEGATION_EXEMPT_KEYWORDS.
  if (NEGATION_EXEMPT_KEYWORDS.includes(kw)) return false;

  let idx = text.indexOf(kw);
  let found = false;

  while (idx !== -1) {
    found = true;
    if (!negatedAt(text, idx, kw)) return false;
    idx = text.indexOf(kw, idx + kw.length);
  }
  return found;
}

/** @private */
function negatedAt(text, idx, kw) {
  // Post-positional negation (Hindi): "दर्द नहीं है"
  const after = text.slice(idx + kw.length, idx + kw.length + 18);
  if (NEGATION_AFTER.some((n) => after.includes(n))) return true;

  // Pre-positional negation (English): "no pain" — immediately preceding word only
  const before = text.slice(Math.max(0, idx - 14), idx).trim().split(/\s+/);
  const prevWord = before[before.length - 1] || '';
  return NEGATION_BEFORE.includes(prevWord.replace(/[^a-z]/g, ''));
}

/**
 * Keyword matching on the caller's speech (fallback).
 * Symptom keywords checked FIRST — "haan le liya lekin bukhar bhi hai" escalates.
 * Distress keywords checked second, ahead of confirmed/denied, for the same
 * reason: a person in distress who also answers the dose question still
 * needs to be routed to ESCALATED_DISTRESS, not CONFIRMED or DENIED.
 * @private
 */
function checkKeywords(callerText) {
  if (!callerText || typeof callerText !== 'string') return null;
  const text = callerText.toLowerCase();

  const symptomHit = SYMPTOM_KEYWORDS.some((kw) => text.includes(kw) && !isNegated(text, kw));
  if (symptomHit) {
    return {
      label: OUTCOMES.ESCALATED_SYMPTOM,
      source: 'keyword_match',
      reason: 'symptom_keyword_detected',
    };
  }
  const distressHit = DISTRESS_KEYWORDS.some((kw) => text.includes(kw) && !isNegated(text, kw));
  if (distressHit) {
    return {
      label: OUTCOMES.ESCALATED_DISTRESS,
      source: 'keyword_match',
      reason: 'distress_keyword_detected',
    };
  }
  if (CONFIRMED_KEYWORDS.some((kw) => text.includes(kw))) {
    return { label: OUTCOMES.CONFIRMED, source: 'keyword_match', reason: 'confirmed_keyword_detected' };
  }
  if (DENIED_KEYWORDS.some((kw) => text.includes(kw))) {
    return { label: OUTCOMES.DENIED, source: 'keyword_match', reason: 'denied_keyword_detected' };
  }
  return null;
}

module.exports = { deriveOutcome, OUTCOMES };
