'use strict';

const logger = require('../../utils/logger');

/** Minutes a dropped call stays resumable. Overridable per call site. */
const DEFAULT_RESUME_WINDOW_MINUTES = Number(process.env.RESUME_WINDOW_MIN || 15);

/**
 * Resolve an inbound caller to a mode and the context that mode needs.
 *
 * This runs between the phone ringing and the agent's first word, inside
 * Vapi's 7.5 second assistant-request budget. Every step is a deterministic
 * read or write — no model call belongs on this path.
 *
 * Returns structured facts only. Turning them into sentences is the use
 * case's job, because the wording is language and use-case specific and
 * core/ has no business composing Hindi.
 *
 * @param {Object} args
 * @param {Object} args.repository - OutcomeRepositoryPort implementation
 * @param {string|null} args.phone - Caller's E.164 number, if the carrier gave one
 * @param {number} [args.resumeWindowMinutes]
 * @param {Date} [args.now] - Injected clock, so the window is testable
 * @param {boolean} [args.createIfUnknown=true] - Create a record for a new caller
 * @returns {Promise<Object>} { mode, patient, session, fieldsSoFar, lastCalls, isNewPatient }
 */
async function resolveInboundCall({
  repository,
  phone,
  resumeWindowMinutes = DEFAULT_RESUME_WINDOW_MINUTES,
  now = new Date(),
  createIfUnknown = true,
}) {
  // No caller ID: answer anyway and collect identity in conversation. Never
  // guess at a record — a wrong match is worse than no match.
  if (!phone) {
    logger.log('inbound_no_caller_id', {});
    return {
      mode: 'inbound',
      patient: null,
      session: null,
      fieldsSoFar: {},
      lastCalls: [],
      isNewPatient: false,
    };
  }

  let patient = await repository.findPatientByPhone(phone);
  let isNewPatient = false;

  if (!patient && createIfUnknown) {
    // A stranger still gets answered, and the record means their second call
    // already knows them. Only the phone number is trusted here; everything
    // else is filled from what they tell us during the call.
    await repository.upsertPatient({ phone });
    patient = await repository.findPatientByPhone(phone);
    isNewPatient = true;
    logger.log('inbound_patient_created', { phone });
  }

  const lastCalls = await repository.recentCallsForPhone(phone, 3);

  const session = patient
    ? await repository.findResumableSession(patient.id, resumeWindowMinutes, now)
    : null;

  const fieldsSoFar = session
    ? await repository.getSessionFields(session.session_id)
    : {};

  const mode = session ? 'resume' : 'inbound';

  logger.log('inbound_resolved', {
    phone,
    mode,
    isNewPatient,
    resumedSession: session ? session.session_id : null,
    priorCalls: lastCalls.length,
  });

  return { mode, patient, session, fieldsSoFar, lastCalls, isNewPatient };
}

module.exports = { resolveInboundCall, DEFAULT_RESUME_WINDOW_MINUTES };
