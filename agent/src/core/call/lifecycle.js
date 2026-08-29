'use strict';

const { resolveInboundCall } = require('../inbound/resolve-caller');
const { terminalStatusFor } = require('../inbound/session-status');
const logger = require('../../utils/logger');

/**
 * Call Lifecycle
 *
 * Transport-agnostic session lifecycle shared by every orchestrator (Vapi
 * today, the playground alongside it). Each transport translates its own
 * native events into calls here; this module never imports Vapi, the
 * playground, or any use case — dependencies (repository, allowed field
 * names) always arrive as parameters, so core/ stays free of adapters.
 *
 * The three functions mirror what used to live inline in the Vapi webhook
 * handler: resolving/opening a call, capturing an intake field turn by
 * turn, and closing a call into its terminal status. Moving them here is
 * what lets the playground drive the same state machine a phone call does,
 * instead of a parallel implementation that silently drifts from it.
 */

/**
 * Resolve and open a call, phone or playground alike.
 *
 * Inbound direction wraps `resolveInboundCall` (never duplicates its
 * caller-resolution or resume logic) and opens a session for THIS call once
 * a patient and a call id are both known. Outbound direction never creates
 * a patient — an outbound call already dialled a chosen number, so an
 * unmatched number just means no session — and never lets a persistence
 * failure propagate: the call already exists by the time this runs, so a
 * DB error here must not undo it.
 *
 * @param {Object} args
 * @param {Object} args.repository - OutcomeRepositoryPort implementation
 * @param {string|null} args.phone - E.164 number
 * @param {'inbound'|'outbound'} [args.direction=inbound]
 * @param {string|null} args.callId - This call/session's id
 * @param {number} [args.resumeWindowMinutes] - Passed through to resolveInboundCall
 * @param {Date} [args.now] - Injected clock, passed through to resolveInboundCall
 * @returns {Promise<Object>} { mode, patient, session, fieldsSoFar, lastCalls, isNewPatient }
 */
async function openCall({ repository, phone, direction = 'inbound', callId, resumeWindowMinutes, now }) {
  if (direction === 'outbound') {
    return _openOutboundCall({ repository, phone, callId });
  }
  return _openInboundCall({ repository, phone, callId, resumeWindowMinutes, now });
}

/** @private */
async function _openInboundCall({ repository, phone, callId, resumeWindowMinutes, now }) {
  const resolution = await resolveInboundCall({ repository, phone, resumeWindowMinutes, now });

  // A minted sessionId in place of a missing call id would create a session
  // end-of-call-report (or its playground equivalent) can never match — an
  // orphaned, unresumable row. Skipping is strictly better: no session at
  // all, rather than one nothing can close.
  if (resolution.patient && callId) {
    await repository.createSession({
      sessionId: callId,
      patientId: resolution.patient.id,
      callId,
      direction: 'inbound',
    });
  } else if (resolution.patient) {
    logger.log('inbound_session_skipped_no_call_id', { phone });
  }

  const session = resolution.patient && callId ? await repository.getSession(callId) : null;

  return {
    mode: resolution.mode,
    patient: resolution.patient,
    session,
    fieldsSoFar: resolution.fieldsSoFar,
    lastCalls: resolution.lastCalls,
    isNewPatient: resolution.isNewPatient,
  };
}

/**
 * @private
 * Mirrors the phone path's outbound session-opening: best-effort, no patient
 * creation, and every failure is logged rather than thrown — dispatching (or
 * starting) the call is the primary effect and must survive a DB hiccup.
 */
async function _openOutboundCall({ repository, phone, callId }) {
  try {
    const patient = await repository.findPatientByPhone(phone);
    if (!patient) {
      // call_id (not callId) matches the field name this log line has always
      // used on the phone path — preserved here for byte-identical log output.
      logger.log('outbound_session_skipped_unknown_patient', { call_id: callId, phone });
      return { mode: 'outbound', patient: null, session: null, fieldsSoFar: {}, lastCalls: [], isNewPatient: false };
    }

    await repository.createSession({ sessionId: callId, patientId: patient.id, callId, direction: 'outbound' });

    return {
      mode: 'outbound',
      patient,
      session: await repository.getSession(callId),
      fieldsSoFar: {},
      lastCalls: [],
      isNewPatient: false,
    };
  } catch (err) {
    logger.error('outbound_session_create_error', err);
    return { mode: 'outbound', patient: null, session: null, fieldsSoFar: {}, lastCalls: [], isNewPatient: false };
  }
}

/**
 * Write a captured intake field to the session, turn by turn.
 *
 * A field name the model invented is logged and dropped rather than
 * written — models emit arbitrary strings, and `allowedFields` (passed in by
 * the caller, never imported here) is the only source of truth for what a
 * session may hold. A callId with no matching session is checked for up
 * front — rather than caught from the repository's own throw — so a real
 * persistence failure still surfaces instead of being swallowed alongside
 * the expected "unknown session" case.
 *
 * @param {Object} args
 * @param {Object} args.repository
 * @param {string} args.callId
 * @param {string} args.field
 * @param {string} args.value
 * @param {string[]} args.allowedFields - Field keys this use case may capture
 */
async function captureField({ repository, callId, field, value, allowedFields }) {
  if (!allowedFields.includes(field)) {
    logger.log('capture_field_unknown_field', { callId, field });
    return;
  }

  if (!callId || !(await repository.getSession(callId))) {
    logger.log('capture_field_unknown_session', { callId, field });
    return;
  }

  await repository.updateSessionFields(callId, { [field]: value });
}

/**
 * Close a call into its terminal status, tolerating a session that does not
 * exist (an outbound call today opens no session before end-of-call, so a
 * missing session here is expected, not an error).
 *
 * @param {Object} args
 * @param {Object} args.repository
 * @param {string|null} args.callId
 * @param {string} [args.endedReason] - Vapi-vocabulary ended reason; see session-status.js
 */
async function closeCall({ repository, callId, endedReason }) {
  if (!callId || !(await repository.getSession(callId))) {
    logger.log('session_end_skipped_unknown_session', { callId });
    return;
  }

  const status = terminalStatusFor(endedReason);
  await repository.endSession(callId, status);
}

module.exports = { openCall, captureField, closeCall };
