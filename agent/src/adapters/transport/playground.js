'use strict';

const crypto = require('node:crypto');

const TransportPort = require('../../core/ports/transport');
const { openCall, captureField, closeCall, recordTurn } = require('../../core/call/lifecycle');
const { INTAKE_FIELDS } = require('../../use-cases/medication-adherence/inbound-context');
const logger = require('../../utils/logger');

/** Prefix that makes a playground session id distinguishable from a real call id at a glance. */
const SESSION_ID_PREFIX = 'playground-';

/**
 * Playground Transport Adapter
 *
 * The playground's counterpart to VapiTransportAdapter — TransportRegistry's
 * second real implementation. Where the phone path gets caller resolution,
 * mode-aware prompts, per-turn field capture and resume-after-drop from
 * Vapi webhooks, the playground drives the exact same lifecycle code
 * (src/core/call/lifecycle.js) from a browser session instead, so the two
 * paths cannot silently drift apart the way they had before this adapter
 * existed.
 *
 * Session ids are minted here rather than reused from anywhere else — the
 * phone path's session id IS the Vapi call id, but a playground session has
 * no call id to borrow. Each id is prefixed so a real and a simulated
 * session are distinguishable at a glance in the database.
 */
class PlaygroundTransportAdapter extends TransportPort {
  constructor(providerRegistry) {
    super();
    this.providerRegistry = providerRegistry;
    this.repository = null;
    this.strategy = null;
  }

  /**
   * Wire the one HTTP route the playground UI needs (the patient picker)
   * and stash the dependencies openSession/captureFieldOnSession/closeSession
   * need. Everything else about a playground conversation is driven directly
   * through this adapter's methods, not through routes here.
   *
   * @param {Object} server - Unused; kept for TransportPort parity
   * @param {Object} engine - Unused; kept for TransportPort parity
   * @param {Object} config - { app, repository, strategy }
   */
  async start(server, engine, config) {
    this.repository = config.repository;
    this.strategy = config.strategy;

    if (config.app) {
      config.app.get('/api/playground/patients', async (req, res) => {
        try {
          const patients = await this.repository.listPatients();
          res.json({ patients });
        } catch (err) {
          logger.error('playground_patients_list_error', err);
          res.status(500).json({ error: err.message });
        }
      });
    }

    logger.log('transport_started', { transport: 'playground' });
  }

  /**
   * Open a playground session for a patient and direction, exactly like the
   * Vapi adapter's assistant-request handler does for a phone call — same
   * lifecycle module, same mode resolution, so an inbound simulated call for
   * a patient with a dropped session opens in `resume` mode too.
   *
   * A playground conversation, unlike a phone call, is entirely mediated by
   * this server — there is no live call already under way that a missing
   * session merely fails to bookkeep for. So unlike the phone path (where
   * openCall's tolerant `session: null` is fine — the call already
   * happened), here a null session means the conversation about to run
   * would persist nothing while looking identical to one that does. Rather
   * than let that happen quietly, this throws, and the caller (the browser,
   * via PlaygroundConversation.start()'s existing error path) is told
   * before a single turn is spoken.
   *
   * A `drugName` makes this a configured demo call rather than a plain
   * simulated one, and it is also what makes an OUTBOUND playground call
   * possible at all: the phone path never creates a patient on outbound (an
   * outbound call already dialled a chosen number, so an unmatched number
   * means no session), and the caregiver trying the playground for the first
   * time is exactly such an unmatched number. Upserting here — in the
   * playground's own adapter, never in core/ — keeps that production rule
   * untouched while giving the demo a record to hang a session on. The upsert
   * is keyed on phone and only fills `drug_name`, so it never overwrites a
   * real patient's name, language or schedule.
   *
   * @param {Object} args
   * @param {string} args.phone - The picked patient's E.164 phone
   * @param {'inbound'|'outbound'} args.direction
   * @param {string|null} [args.drugName] - Medicine picked in the playground UI
   * @returns {Promise<Object>} { sessionId, mode, patient, session, fieldsSoFar, lastCalls, isNewPatient }
   * @throws {Error} If no session row was opened for this call — an
   *   unmatched outbound number, or a resolution/persistence failure.
   */
  async openSession({ phone, direction, drugName = null }) {
    const sessionId = _mintSessionId();

    if (phone && drugName) {
      await this.repository.upsertPatient({ phone, drugName });
    }
    const resolution = await openCall({
      repository: this.repository,
      phone,
      direction,
      callId: sessionId,
    });

    if (!resolution.session) {
      logger.log('playground_session_open_failed', { phone, direction, sessionId });
      throw new Error(
        `Could not open a session for this ${direction} call — ` +
          (resolution.patient
            ? 'a database error prevented the session from being created.'
            : 'no matching patient was found.') +
          ' Nothing would be recorded, so the conversation was not started.'
      );
    }

    return { sessionId, ...resolution };
  }

  /**
   * Route a `capture_field` tool call through the shared lifecycle module.
   *
   * @param {Object} args
   * @param {string} args.sessionId
   * @param {string} args.field
   * @param {string} args.value
   */
  async captureField({ sessionId, field, value }) {
    await captureField({
      repository: this.repository,
      callId: sessionId,
      field,
      value,
      allowedFields: INTAKE_FIELDS.map((f) => f.key),
    });
  }

  /**
   * Route one turn of a playground conversation through the shared
   * lifecycle module — same write path the phone transport uses, so
   * PlaygroundConversation never touches the repository directly.
   *
   * @param {Object} args
   * @param {string} args.sessionId
   * @param {string} args.role - 'user' | 'assistant'
   * @param {string|null} [args.content]
   * @param {Array|null} [args.toolCalls]
   */
  async recordTurn({ sessionId, role, content, toolCalls }) {
    await recordTurn({ repository: this.repository, callId: sessionId, role, content, toolCalls });
  }

  /**
   * Close a playground session into its terminal status.
   *
   * @param {Object} args
   * @param {string} args.sessionId
   * @param {string} [args.endedReason] - Vapi-vocabulary ended reason (see
   *   session-status.js); the caller picks one that maps to the right
   *   terminal status — 'customer-ended-call' for a normal end, anything
   *   else (including undefined, e.g. a browser disconnect) for dropped.
   */
  async closeSession({ sessionId, endedReason }) {
    await closeCall({ repository: this.repository, callId: sessionId, endedReason });
  }

  /**
   * Not applicable — the playground has no orchestrator assistant config to
   * build. Present only because TransportPort declares it.
   */
  buildAssistantConfig() {
    throw new Error(
      'PlaygroundTransportAdapter.buildAssistantConfig() is not applicable — the playground has no orchestrator.'
    );
  }

  /**
   * Not applicable — the playground never dials out. Present only because
   * TransportPort declares it.
   */
  getAssistantId() {
    throw new Error(
      'PlaygroundTransportAdapter.getAssistantId() is not applicable — the playground never dials out.'
    );
  }

  async createCall() {
    throw new Error('PlaygroundTransportAdapter.createCall() is not applicable — the playground never dials out.');
  }

  /**
   * @see TransportPort#requiredSecrets
   *
   * The playground is a browser session, not a phone call — there is no
   * vendor webhook to authenticate and no orchestrator to share a secret
   * with, so it needs none. Explicit empty array rather than inheriting a
   * default, per TransportPort's contract: a transport that needs no secret
   * says so on purpose.
   *
   * @returns {Array<{name: string, why: string}>}
   */
  requiredSecrets() {
    return [];
  }
}

/**
 * Mint a session id that is obviously a playground id, never a real call id.
 * @returns {string}
 * @private
 */
function _mintSessionId() {
  return `${SESSION_ID_PREFIX}${crypto.randomUUID()}`;
}

module.exports = PlaygroundTransportAdapter;
module.exports.SESSION_ID_PREFIX = SESSION_ID_PREFIX;
