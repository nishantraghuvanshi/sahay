'use strict';

const logger = require('../../../utils/logger');
const { withRetry } = require('../../../utils/retry');
const { OUTCOMES } = require('../outcomes');

/**
 * Escalation Alert Plugin
 *
 * Closes the loop on ESCALATED_SYMPTOM and ESCALATED_DISTRESS. Without it the
 * highest-stakes outcomes the product can produce are a database row that
 * nobody reads.
 *
 * Two messages, two recipients, deliberately different (PILOT-PLAN.md §2.3):
 *
 *   Operator  — full detail: call id, derivation source, the reason text.
 *   Caregiver — neutral nudge. No symptom named, no medical claim made.
 *
 * Suppression rule: escalations derived from `keyword_match` alone go to the
 * operator ONLY. That detector is an unvalidated heuristic whose precision is
 * the very thing the pilot measures, so a human stays between it and a worried
 * family until it has earned the right to page them directly.
 */
class EscalationAlertPlugin {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.repository] - Repository exposing recordAlert()
   * @param {Function} [deps.send] - async (recipient, text) => void
   * @param {string} [deps.operatorContact] - Where operator alerts go
   * @param {string} [deps.channel] - Label recorded on success
   * @param {number} [deps.retries]
   */
  constructor(deps = {}) {
    this.repository = deps.repository || null;
    this.send = deps.send !== undefined ? deps.send : buildSender();
    this.operatorContact = deps.operatorContact !== undefined
      ? deps.operatorContact
      : process.env.ALERT_OPERATOR_CONTACT || null;
    this.channel = deps.channel || channelName();
    this.retries = deps.retries ?? 2;
  }

  get name() {
    return 'escalation-alert';
  }

  /**
   * Engine hook. Fires only when strategy.shouldEscalate() returned true,
   * but the label is re-checked here so the plugin is safe to call directly.
   *
   * @param {Object} outcome - { label, source, reason }
   * @param {Object} callData - { callId, variables, ... }
   */
  async onEscalation(outcome, callData = {}) {
    const ESCALATING_LABELS = [OUTCOMES.ESCALATED_SYMPTOM, OUTCOMES.ESCALATED_DISTRESS];
    if (!outcome || !ESCALATING_LABELS.includes(outcome.label)) return;

    const callId = callData.callId;
    const vars = callData.variables || {};
    const parentName = vars.parent_name || 'your parent';
    const caregiverContact = vars.caregiver_contact || null;

    // Unvalidated detector → operator only. See class docblock.
    const keywordOnly = outcome.source === 'keyword_match';

    const recipients = [];
    if (this.operatorContact) {
      recipients.push({ to: this.operatorContact, text: operatorMessage(outcome, callData) });
    }
    if (caregiverContact && !keywordOnly) {
      recipients.push({ to: caregiverContact, text: caregiverMessage(parentName) });
    }

    if (!this.send || recipients.length === 0) {
      logger.log('escalation_alert_unconfigured', {
        callId,
        reason: !this.send ? 'no_transport' : 'no_recipients',
        source: outcome.source,
      });
      // Loud: an escalation happened and nobody was told.
      console.error(JSON.stringify({
        event: 'escalation_not_delivered',
        callId,
        label: outcome.label,
        detail: 'No alert transport or recipient configured. Nobody was notified.',
      }));
      await this._record(callId, 'none');
      return;
    }

    let delivered = 0;
    for (const { to, text } of recipients) {
      try {
        await withRetry(() => this.send(to, text), { maxRetries: this.retries, retryOn: () => true });
        delivered += 1;
        logger.log('escalation_alert_sent', { callId, channel: this.channel, source: outcome.source });
      } catch (err) {
        // Never rethrow — a failed alert must be recorded, not propagated into
        // the engine where it would abort the rest of the end-of-call handling.
        console.error(JSON.stringify({
          event: 'escalation_alert_failed',
          callId,
          label: outcome.label,
          error: err.message,
          detail: `${outcome.label} alert could not be delivered.`,
        }));
      }
    }

    await this._record(callId, delivered > 0 ? this.channel : 'failed');
  }

  /** @private */
  async _record(callId, channel) {
    if (!this.repository || typeof this.repository.recordAlert !== 'function') return;
    try {
      await this.repository.recordAlert(callId, channel);
    } catch (err) {
      logger.error('escalation_alert_record_failed', err);
    }
  }
}

/** @private */
function operatorMessage(outcome, callData) {
  return [
    `${outcome.label} · ${callData.variables?.parent_name || 'unknown'} · ${callData.callId}`,
    `source: ${outcome.source}`,
    `reason: ${outcome.reason}`,
  ].join('\n');
}

/**
 * Deliberately makes no medical claim and names no symptom.
 * The agent is unvalidated; "please check in" is safe when wrong,
 * "your mother reported chest pain" is not.
 * @private
 */
function caregiverMessage(parentName) {
  return `Your check-in call with ${parentName} just now suggested they may not be feeling well. `
    + `Please give them a call when you can.`;
}

/**
 * Default transport: Telegram bot sendMessage. Chosen for the pilot because it
 * needs no number provisioning and no infrastructure — it is meant to be thrown
 * away with the rest of this stack.
 * @private
 */
function channelName() {
  if (process.env.ALERT_CHANNEL) return process.env.ALERT_CHANNEL;
  // Whichever transport is actually credentialled, rather than a fixed default
  // that names a channel nothing can send on. The label is recorded against the
  // call, so it has to describe what really carried the message.
  if (process.env.ALERT_TELEGRAM_BOT_TOKEN) return 'telegram';
  if (process.env.RESEND_API_KEY) return 'email';
  return 'telegram';
}

/**
 * Pick the transport the environment can actually use.
 *
 * This returned `buildTelegramSender()` unconditionally, and with no bot token
 * that is null — so every escalation took the `!this.send` branch, recorded
 * `channel: 'none'` and notified nobody. A real call on 30 Aug hit exactly that:
 * the agent told a patient it would inform their family, and nothing was sent.
 * @private
 */
function buildSender() {
  const channel = channelName();
  if (channel === 'email') return buildEmailSender();
  return buildTelegramSender();
}

/**
 * Email over Resend's HTTP API — `fetch`, no new dependency, and the same
 * credential the API already sends OTPs with.
 *
 * Caveat worth knowing before trusting it: on Resend's shared sandbox domain
 * only the account holder's own address is deliverable. An alert to anyone else
 * is accepted and dropped, which is why delivery is verified rather than assumed
 * (`api/config.py` records the same limitation for OTP email).
 * @private
 */
function buildEmailSender() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return null;

  return async (to, text) => {
    if (!String(to).includes('@')) {
      // A phone number reached an email transport. Throwing rather than posting
      // it keeps the failure countable: it lands in the delivery tally and is
      // recorded as 'failed', instead of Resend 200-ing on an address that can
      // never receive anything.
      throw new Error(`Alert recipient "${to}" is not an email address`);
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Voxikin alert — a call needs a person',
        text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend send failed (${response.status}): ${await response.text()}`);
    }
  };
}

function buildTelegramSender() {
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  return async (chatId, text) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed (${response.status}): ${await response.text()}`);
    }
  };
}

module.exports = EscalationAlertPlugin;
