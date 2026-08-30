'use strict';

/**
 * The call as a state machine, phase 1 — the core spine.
 *
 * The single-prompt design put every rule in context on every turn and asked
 * the model to follow a CALL FLOW section. That works, but nothing structurally
 * stops it wandering: "stop the medication reminder and never return to it" is
 * a sentence the model chooses to obey. Splitting the call into members makes
 * each turn carry one goal, and makes the emergency exit a transition rather
 * than an instruction.
 *
 * Shape borrowed from the prior ElevenLabs agent (.sahay-local/elevenlabs/),
 * whose 19-node graph is the reference design. This is its spine; the clinical
 * branches (meal gating, before/after food, stay-on-line, timing mismatch,
 * refusal) and the third-party/caregiver/voicemail branches are phases 2 and 3.
 *
 * Two rules hold this together and are enforced by tests, not convention:
 *
 *  1. Every member's prompt is composed through the strategy's single
 *     guardrail path. A member cannot be built without the safety block. The
 *     old design's one virtue was that guardrails provably applied everywhere;
 *     a dozen members is a dozen chances to lose that, so it is asserted.
 *
 *  2. EMERGENCY and OPT_OUT are GLOBAL — reachable from every member. The
 *     reference design reaches emergency from two nodes; that is a bug waiting
 *     for a patient who reports chest pain during the wellbeing question rather
 *     than the greeting. Anything a patient can say at any moment needs an exit
 *     from any state.
 */

/** Members every other member can transition to, from anywhere. */
const GLOBAL_MEMBERS = ['emergency', 'opt_out'];

/**
 * Each member: one goal, the phrasing it may use, and where it can go.
 *
 * `goal` becomes the lead block of that member's system prompt. Written in the
 * house style of the reference design — state the goal, state what does NOT
 * happen here, then give example phrasing rather than a script, so the model
 * stays conversational instead of reciting.
 *
 * `destinations[].description` is the semantic condition Vapi matches against
 * the conversation, so it is written as an observable fact about what the
 * caller said, never as an instruction to the model.
 */
const MEMBERS = [
  {
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
    destinations: [
      { to: 'disclose', description: 'The person confirms they are the patient.' },
    ],
  },

  {
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
    destinations: [
      { to: 'dose_check', description: 'The patient has heard what is due.' },
    ],
  },

  {
    key: 'dose_check',
    label: 'Dose Check',
    goal: [
      'Goal: establish whether the dose has been taken. One question, then listen.',
      '',
      'Ask plainly: "क्या आपने अपनी दवाई ले ली है?"',
      '',
      'Accept a clear yes or a clear no. If the answer is ambiguous, ask ONCE more in',
      'simpler words. Do not ask a third time — an unclear answer is a valid outcome and',
      'pressing an elderly caller is worse than not knowing.',
      '',
      'If they say they have not taken it, do not persuade, lecture, or repeat why it',
      'matters. You may state once, neutrally, that it is what their doctor advised.',
      'Never suggest a dose, a time, or an alternative.',
    ].join('\n'),
    destinations: [
      { to: 'wellbeing', description: 'The patient has given a clear yes or no about the dose, or has been asked twice without a clear answer.' },
    ],
  },

  {
    key: 'wellbeing',
    label: 'Wellbeing Check',
    goal: [
      'Goal: one open question about how they are, then close.',
      '',
      'Ask warmly: "जाने से पहले — आज आपकी तबियत कैसी है? कोई तकलीफ़ तो नहीं?"',
      '',
      'This is one question, not an assessment. Do not probe, do not ask follow-ups about',
      'symptoms, and never interpret what they tell you. If they mention anything that',
      'sounds like a medical emergency or emotional distress, that is not for this step to',
      'handle — it is handled elsewhere and takes priority over finishing the call.',
    ].join('\n'),
    destinations: [
      { to: 'close', description: 'The patient reports they are fine, or gives a routine answer with no emergency and no distress.' },
    ],
  },

  {
    key: 'close',
    label: 'Close',
    goal: [
      'Goal: record the outcome and end the call warmly.',
      '',
      'Call report_outcome EXACTLY ONCE with what actually happened:',
      'CONFIRMED if they said they took it, DENIED if they said they had not,',
      'UNCLEAR if you asked twice and still could not tell.',
      '',
      'Then say goodbye — "अपना ख़याल रखियेगा। धन्यवाद।" — and end the call.',
      'Say nothing after ending it.',
    ].join('\n'),
    terminal: true,
    destinations: [],
  },

  // ── Global members ────────────────────────────────────────────────
  // Reachable from every member above. See GLOBAL_MEMBERS.

  {
    key: 'emergency',
    label: 'Emergency / Unwell',
    global: true,
    terminal: true,
    goal: [
      'Goal: the patient has reported something that may be a medical emergency or',
      'serious distress. The medication reminder is over. Do not return to it — there is',
      'no transition back from here, and that is deliberate.',
      '',
      'Follow the emergency or distress sequence in your guardrails exactly. Do not decide',
      'for yourself whether it sounds serious, do not ask follow-up questions, and do not',
      'guess at a cause.',
      '',
      'Then call report_outcome with ESCALATED_SYMPTOM for a physical emergency or',
      'ESCALATED_DISTRESS for emotional distress, and end the call.',
    ].join('\n'),
    destinations: [],
  },

  {
    key: 'opt_out',
    label: 'Stop Calling Request',
    global: true,
    terminal: true,
    goal: [
      'Goal: the patient has asked not to be called again. Honour it immediately and',
      'without friction.',
      '',
      'Do not ask why, do not try to talk them out of it, and do not explain what they',
      'will miss. Say once: "ज़रूर, मैं आपको दोबारा फ़ोन नहीं करूँगी। अपना ख़याल रखियेगा।"',
      '',
      'Then call report_outcome with INCOMPLETE and the reason "stop_calling_requested",',
      'and end the call. Someone will follow this up; you do not need to.',
    ].join('\n'),
    destinations: [],
  },
];

/** Conditions on which any member hands off to a global member. */
const GLOBAL_DESTINATIONS = {
  emergency:
    'The patient reports chest pain, difficulty breathing, severe dizziness, fainting, bleeding, a fall, sudden weakness, slurred speech, severe pain, confusion about who or where they are, thoughts of self-harm, or a wish to stop treatment altogether.',
  opt_out:
    'The patient asks not to be called again, or to be removed from these calls.',
};

module.exports = { MEMBERS, GLOBAL_MEMBERS, GLOBAL_DESTINATIONS };
