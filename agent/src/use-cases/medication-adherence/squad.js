'use strict';

/**
 * The call as a state machine.
 *
 * Shape borrowed from the prior ElevenLabs agent (.sahay-local/elevenlabs/),
 * whose 19-node graph is the reference design.
 *
 * Two rules hold this together and are enforced by tests, not convention:
 *
 *  1. Every member's prompt is composed through the strategy's single
 *     guardrail path. A member cannot be built without the safety block.
 *
 *  2. EMERGENCY and OPT_OUT are GLOBAL — reachable from every non-terminal
 *     member. The reference design reaches emergency from two nodes; that
 *     strands a patient who reports chest pain during the wellbeing question
 *     rather than the greeting.
 *
 * ── Why the food rule selects the graph instead of branching inside it ──
 *
 * Whether a medicine goes before or after food is DATA, known before the call
 * ever connects. The reference design made it a runtime branch because its
 * graph is static and shared by every call. Ours is assembled per call, so the
 * branch happens at construction: an after-food regimen never builds the
 * before-food states at all.
 *
 * That matters beyond tidiness. A semantic edge asks the model to decide
 * something the database already knows, and a model that decides wrong asks an
 * elderly patient to take a dose on an empty stomach. Deterministic where the
 * answer is known; semantic only for what the caller actually says.
 */

/** Members every non-terminal member can transition to, from anywhere. */
const GLOBAL_MEMBERS = ['emergency', 'opt_out'];

/**
 * Normalise the free-text `medications.food_rule` column.
 *
 * The column has no constraint and seeds write 'after'. Anything unrecognised
 * — including null — yields the generic spine rather than a guess: asking
 * about a meal that the prescription never mentioned is worse than not asking.
 *
 * @param {string|null|undefined} raw
 * @returns {'after'|'before'|'none'}
 */
function normaliseFoodRule(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (/(^|[^a-z])after/.test(value) || value === 'pc' || value.includes('post')) return 'after';
  if (/(^|[^a-z])before/.test(value) || value === 'ac' || value.includes('empty')) return 'before';
  return 'none';
}

// ── Members shared by every variant ──────────────────────────────────

const GREETING = {
  key: 'greeting',
  label: 'Greeting & Check-in',
  first: true,
  goal: [
    'Goal: confirm you are speaking with {{parent_name}}. Nothing else happens in this step.',
    '',
    'Do NOT say the medicine name, the dose, or any condition here — you do not yet know',
    'who is holding the phone, and naming a medicine to the wrong person discloses a',
    'diagnosis. That restraint is the entire purpose of this step.',
    '',
    'Greet warmly and ask if you are speaking with them. Example shape:',
    '"नमस्ते, मैं आशा बोल रही हूँ। क्या मैं {{parent_name}} जी से बात कर रही हूँ?"',
    '',
    'Accept a clear yes. If someone else answers, or you are unsure, do not proceed.',
  ].join('\n'),
  destinations: [{ to: 'disclose', description: 'The person confirms they are the patient.' }],
};

const WELLBEING = {
  key: 'wellbeing',
  label: 'Wellbeing Check',
  goal: [
    'Goal: one open question about how they are, then close.',
    '',
    'Ask warmly: "जाने से पहले — आज आपकी तबियत कैसी है? कोई तकलीफ़ तो नहीं?"',
    '',
    'This is one question, not an assessment. Do not probe, do not ask follow-ups about',
    'symptoms, and never interpret what they tell you. If they mention anything that',
    'sounds like a medical emergency or emotional distress, that is handled elsewhere and',
    'takes priority over finishing the call.',
  ].join('\n'),
  destinations: [
    { to: 'close', description: 'The patient reports they are fine, or gives a routine answer with no emergency and no distress.' },
  ],
};

const CLOSE = {
  key: 'close',
  label: 'Close',
  terminal: true,
  goal: [
    'Goal: record the outcome and end the call warmly.',
    '',
    'Call report_outcome EXACTLY ONCE with what actually happened:',
    'CONFIRMED if they took the dose, DENIED if they had not and did not take it,',
    'UNCLEAR if you asked twice and still could not tell.',
    '',
    'Then say goodbye — "अपना ख़याल रखियेगा। धन्यवाद।" — and end the call.',
    'Say nothing after ending it.',
  ].join('\n'),
  destinations: [],
};

const STAY_ON_LINE = {
  key: 'stay_on_line',
  label: 'Stay On Line',
  goal: [
    'Goal: wait, quietly, while they take the dose. This step is mostly silence.',
    '',
    'Say once: "कोई बात नहीं, मैं लाइन पर ही हूँ — आप अभी ले लीजिये, और हो जाए तो बता दीजियेगा।"',
    '',
    'Then STOP TALKING. Do not fill the silence, do not chat, do not ask whether they have',
    'found it, and do not hurry them. An elderly person may take a minute or more to reach',
    'their tablets. If they speak, respond briefly and go quiet again.',
    '',
    'Only move on when they say they have taken it.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The patient says they have now taken the dose.' },
  ],
};

const REFUSAL = {
  key: 'refusal',
  label: 'Refusal',
  goal: [
    'Goal: record that they are choosing not to take this dose, and why, without',
    'persuading them.',
    '',
    'You may state ONCE, neutrally, that this is what their doctor advised. Then accept it.',
    'Do not repeat it, do not warn them what might happen, do not bargain, and do not',
    'express disappointment. It is their decision and pressing an elderly person about',
    'medication is not care.',
    '',
    'Ask once, gently, if there is a reason — "कोई ख़ास वजह है?" — and record whatever they',
    'say verbatim. If they would rather not say, that is a complete answer.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The refusal has been acknowledged, with or without a stated reason.' },
  ],
};

const EMERGENCY = {
  key: 'emergency',
  label: 'Emergency / Unwell',
  global: true,
  terminal: true,
  goal: [
    'Goal: the patient has reported something that may be a medical emergency or serious',
    'distress. The medication reminder is over. Do not return to it — there is no',
    'transition back from here, and that is deliberate.',
    '',
    'Follow the emergency or distress sequence in your guardrails exactly. Do not decide',
    'for yourself whether it sounds serious, do not ask follow-up questions, and do not',
    'guess at a cause.',
    '',
    'Then call report_outcome with ESCALATED_SYMPTOM for a physical emergency or',
    'ESCALATED_DISTRESS for emotional distress, and end the call.',
  ].join('\n'),
  destinations: [],
};

const OPT_OUT = {
  key: 'opt_out',
  label: 'Stop Calling Request',
  global: true,
  terminal: true,
  goal: [
    'Goal: the patient has asked not to be called again. Honour it immediately and without',
    'friction.',
    '',
    'Do not ask why, do not try to talk them out of it, and do not explain what they will',
    'miss. Say once: "ज़रूर, मैं आपको दोबारा फ़ोन नहीं करूँगी। अपना ख़याल रखियेगा।"',
    '',
    'Then call report_outcome with INCOMPLETE and the reason "stop_calling_requested",',
    'and end the call. Someone will follow this up; you do not need to.',
  ].join('\n'),
  destinations: [],
};

// ── Variant-specific members ─────────────────────────────────────────

/** The generic spine, used when the prescription carries no food rule. */
const GENERIC_DOSE_CHECK = {
  key: 'dose_check',
  label: 'Dose Check',
  goal: [
    'Goal: establish whether the dose has been taken. One question, then listen.',
    '',
    'Ask plainly: "क्या आपने अपनी दवाई ले ली है?"',
    '',
    'Accept a clear yes or a clear no. If the answer is ambiguous, ask ONCE more in simpler',
    'words. Do not ask a third time — an unclear answer is a valid outcome, and pressing an',
    'elderly caller is worse than not knowing.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The patient has confirmed they took the dose, or has been asked twice without a clear answer.' },
    { to: 'stay_on_line', description: 'The patient says they will take the dose right now.' },
    { to: 'refusal', description: 'The patient says they do not want to take the dose.' },
  ],
};

const MEAL_CHECK = {
  key: 'meal_check',
  label: 'Meal Check',
  goal: [
    'Goal: find out whether {{parent_name}} has eaten. This gates everything after it.',
    '',
    'This medicine is prescribed for AFTER food, so the meal comes first. Ask plainly:',
    '"क्या आपने खाना खा लिया है?"',
    '',
    'Accept a clear yes or no. Do not ask what they ate, do not comment on it, and do not',
    'ask about the medicine yet.',
  ].join('\n'),
  destinations: [
    { to: 'dose_check_after', description: 'The patient has eaten.' },
    { to: 'callback_meal', description: 'The patient has not eaten yet.' },
  ],
};

const DOSE_CHECK_AFTER = {
  key: 'dose_check_after',
  label: 'Dose Check (after food)',
  goal: [
    'Goal: they have eaten, so the prescribed condition is met. Establish dose status.',
    '',
    'Ask: "और अपनी दवाई ले ली?" If they have not, ask them to take it now:',
    '"तो अब ले लीजिये — खाना हो गया है, यही सही समय है।"',
    '',
    'Do not state a dose amount and do not suggest a different time. If they decline, do',
    'not persuade.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The patient has already taken the dose.' },
    { to: 'stay_on_line', description: 'The patient says they will take the dose right now.' },
    { to: 'refusal', description: 'The patient says they do not want to take the dose.' },
  ],
};

const CALLBACK_MEAL = {
  key: 'callback_meal',
  label: 'Callback (meal not eaten)',
  goal: [
    'Goal: this medicine is prescribed for after food and they have not eaten. The',
    'prescribed condition is NOT met, so there is no instruction to give here.',
    '',
    'Do NOT tell them to take it anyway, do not tell them to eat, and do not suggest when',
    'to do either — that is prescribing, and it is not yours to do.',
    '',
    'Say warmly that you will check back later:',
    '"कोई बात नहीं — खाना हो जाए तो दवाई ले लीजियेगा। मैं थोड़ी देर में फिर पूछ लूँगी।"',
    '',
    'Then move on. Do not ask again in this call.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The patient has been told a follow-up will happen after their meal.' },
  ],
};

const DOSE_CHECK_BEFORE = {
  key: 'dose_check_before',
  label: 'Dose Check (before food)',
  goal: [
    'Goal: this medicine goes BEFORE food. Establish dose status and whether they have',
    'already eaten.',
    '',
    'Ask first: "क्या आपने अपनी दवाई ले ली है?" If they have not, ask whether they have',
    'eaten yet: "और खाना खाया?"',
    '',
    'If they have NOT eaten, this is correct timing — ask them to take it now and reassure',
    'them: "बढ़िया, यही सही समय है — यह दवाई खाने से पहले लेनी है।"',
    '',
    'If they have ALREADY eaten, do not tell them to take it and do not tell them to skip',
    'it. That is handled in the next step.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The patient has already taken the dose.' },
    { to: 'stay_on_line', description: 'The patient has not eaten and says they will take the dose right now.' },
    { to: 'timing_mismatch', description: 'The patient has not taken the dose but has already eaten.' },
    { to: 'refusal', description: 'The patient says they do not want to take the dose.' },
  ],
};

const TIMING_MISMATCH = {
  key: 'timing_mismatch',
  label: 'Timing Mismatch',
  goal: [
    'Goal: a before-food dose is untaken and they have already eaten. The prescribed window',
    'has passed.',
    '',
    'Whether to take it late, skip it, or wait is a DOSING DECISION and it is not yours to',
    'make. Do not tell them to take it, do not tell them to skip it, and do not suggest a',
    'new time. Never say whether missing it matters.',
    '',
    'Say only that the timing is worth checking with whoever prescribed it:',
    '"यह दवाई खाने से पहले लेनी होती है, और खाना हो चुका है। इस बारे में एक बार अपने डॉक्टर से पूछ लीजियेगा।"',
    '',
    'Record what happened. Do not ask them to decide now.',
  ].join('\n'),
  destinations: [
    { to: 'wellbeing', description: 'The timing mismatch has been noted and the patient has been told to check with their doctor.' },
  ],
};

/** `disclose` differs only in where it hands off, which the food rule decides. */
function discloseFor(nextKey) {
  return {
    key: 'disclose',
    label: 'Disclose what is due',
    goal: [
      'Goal: tell them what is due and why, in one turn, then move on.',
      '',
      'Order matters: the reason first, then the medicine, then the timing — it lands as',
      'care rather than as an instruction. Example shape:',
      '"{{caregiver_name}} जी ने कहा था कि मैं याद दिला दूँ — आपकी {{drug_name}} लेने का समय हो गया है।"',
      '',
      'Say it once. Do not ask whether they have taken it yet — that is the next step.',
      'Do not explain what the medicine does, and do not comment on the condition.',
    ].join('\n'),
    destinations: [{ to: nextKey, description: 'The patient has heard what is due.' }],
  };
}

/**
 * Assemble the member graph for one call.
 *
 * @param {string|null} foodRule - raw medications.food_rule
 * @returns {Array} member definitions
 */
function membersFor(foodRule) {
  const rule = normaliseFoodRule(foodRule);
  const shared = [WELLBEING, CLOSE, STAY_ON_LINE, REFUSAL, EMERGENCY, OPT_OUT];

  if (rule === 'after') {
    return [GREETING, discloseFor('meal_check'), MEAL_CHECK, DOSE_CHECK_AFTER, CALLBACK_MEAL, ...shared];
  }
  if (rule === 'before') {
    return [GREETING, discloseFor('dose_check_before'), DOSE_CHECK_BEFORE, TIMING_MISMATCH, ...shared];
  }
  return [GREETING, discloseFor('dose_check'), GENERIC_DOSE_CHECK, ...shared];
}

module.exports = {
  membersFor,
  normaliseFoodRule,
  GLOBAL_MEMBERS,
  GLOBAL_DESTINATIONS: {
    emergency:
      'The patient reports chest pain, difficulty breathing, severe dizziness, fainting, bleeding, a fall, sudden weakness, slurred speech, severe pain, confusion about who or where they are, thoughts of self-harm, or a wish to stop treatment altogether.',
    opt_out:
      'The patient asks not to be called again, or to be removed from these calls.',
  },
};
