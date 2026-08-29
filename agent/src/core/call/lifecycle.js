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
 * @returns {Promise<Object>} { mode, patient, session, resumedSession, fieldsSoFar, lastCalls, isNewPatient } —
 *   `session` is the row opened (or attempted) for THIS call; `resumedSession`
 *   (inbound only, otherwise always null) is the prior dropped session, if
 *   any, that made `mode` resolve to 'resume'. These are two different rows
 *   and must not be confused — see _openInboundCall's comment.
 */
async function openCall({ repository, phone, direction = 'inbound', callId, resumeWindowMinutes, now }) {
  await _ensureCallRow({ repository, callId, phone });

  if (direction === 'outbound') {
    return _openOutboundCall({ repository, phone, callId });
  }
  return _openInboundCall({ repository, phone, callId, resumeWindowMinutes, now });
}

/**
 * Make sure a `calls` row exists for this call id before anything (turn
 * history in particular — see recordTurn below) tries to reference it.
 * messages.call_id is a foreign key against calls.call_id, and nothing
 * else in this codebase creates that row until the call ends — without
 * this, every mid-call message insert would fail its FK constraint.
 *
 * Best-effort and non-fatal: opening (or dialling) the call is the primary
 * effect and must survive a DB hiccup here. createCall() is idempotent on
 * call_id, so this is safe to call on every openCall, including a resumed
 * or retried one.
 *
 * @private
 */
async function _ensureCallRow({ repository, callId, phone }) {
  if (!callId) return;
  try {
    await repository.createCall({ callId, phone });
  } catch (err) {
    logger.error('call_row_create_error', err, { callId });
  }
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

  // `resolution.session` (from resolveInboundCall) is the RESUMABLE session
  // from a prior dropped call, if any — not the row just (maybe) created
  // above for THIS call. Returning both under one name ("session") would
  // silently hand a caller the wrong row depending on which one they meant;
  // see this function's doc comment.
  const newSession = resolution.patient && callId ? await repository.getSession(callId) : null;

  return {
    mode: resolution.mode,
    patient: resolution.patient,
    session: newSession,
    resumedSession: resolution.session,
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
      return { mode: 'outbound', patient: null, session: null, resumedSession: null, fieldsSoFar: {}, lastCalls: [], isNewPatient: false };
    }

    await repository.createSession({ sessionId: callId, patientId: patient.id, callId, direction: 'outbound' });

    return {
      mode: 'outbound',
      patient,
      session: await repository.getSession(callId),
      resumedSession: null,
      fieldsSoFar: {},
      lastCalls: [],
      isNewPatient: false,
    };
  } catch (err) {
    logger.error('outbound_session_create_error', err);
    return { mode: 'outbound', patient: null, session: null, resumedSession: null, fieldsSoFar: {}, lastCalls: [], isNewPatient: false };
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

/**
 * Persist one turn of a conversation — user, assistant, or a tool call —
 * tolerating whatever a live call can throw at it. A missing call id or a
 * call id with no matching `calls` row (an unknown call) is logged and
 * dropped rather than thrown: losing one turn of history must never take
 * down a live call the way a thrown error would.
 *
 * @param {Object} args
 * @param {Object} args.repository
 * @param {string|null} args.callId
 * @param {string} args.role - 'user' | 'assistant' | ...
 * @param {string|null} [args.content]
 * @param {Array|null} [args.toolCalls]
 */
async function recordTurn({ repository, callId, role, content, toolCalls }) {
  if (!callId) {
    logger.log('record_turn_skipped_no_call_id', { role });
    return;
  }

  try {
    await repository.saveMessage({
      callId,
      role,
      content: content ?? null,
      toolCalls: toolCalls || null,
    });
  } catch (err) {
    logger.error('record_turn_error', err, { callId, role });
  }
}

module.exports = { openCall, captureField, closeCall, recordTurn };
