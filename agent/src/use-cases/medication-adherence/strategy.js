'use strict';

const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const ConversationStrategy = require('../../core/strategy/base');
const { deriveOutcome, OUTCOMES } = require('./outcomes');
const { TOOLS } = require('./tools');
const { MEMBERS, GLOBAL_MEMBERS, GLOBAL_DESTINATIONS } = require('./squad');

/**
 * Medication Adherence Strategy
 *
 * Implements ConversationStrategy for the medication adherence use case.
 * Owns: system prompt, first message, tools, outcome derivation, escalation rules.
 *
 * This is a use-case plugin — the conversation engine delegates all
 * use-case-specific logic here. Adding a new use case (e.g., emergency triage)
 * means creating a new strategy, not modifying the engine.
 */
class MedicationAdherenceStrategy extends ConversationStrategy {
  constructor(language = 'hi') {
    super();
    this.language = language;
    // Load use-case config (prompts, variables, version) for the selected language
    const configFile = language === 'en'
      ? 'medication-adherence-en.yaml'
      : 'medication-adherence.yaml';
    const configPath = path.join(__dirname, '../../../config/use-cases/', configFile);
    const raw = fs.readFileSync(configPath, 'utf8');
    this.config = yaml.load(raw);
  }

  get name() {
    return 'medication-adherence';
  }

  /** @returns {string[]} Entry modes this strategy supports. */
  getModes() {
    return ['outbound', ...Object.keys(this.config.modes || {})];
  }

  /**
   * The raw prompt block for a mode, before composition.
   *
   * `outbound` lives at the top level of the config rather than under
   * `modes:` so the shape stays backward compatible with single-mode configs.
   *
   * @param {string} mode - outbound | inbound | resume
   * @returns {{system_prompt: string, first_message: string}}
   */
  getModeBlock(mode) {
    if (mode === 'outbound') {
      return {
        system_prompt: this.config.system_prompt,
        first_message: this.config.first_message,
      };
    }
    const block = this.config.modes && this.config.modes[mode];
    if (!block) {
      throw new Error(
        `Unknown mode: "${mode}". Available: ${this.getModes().join(', ')}`
      );
    }
    return block;
  }

  /**
   * Compose the system prompt for a mode.
   *
   * Order is deliberate: mode block, then shared rules, then guardrails LAST,
   * so the non-negotiable rules are the most recent instruction in context.
   * Guardrails are stored once and never duplicated into a mode — three modes
   * each carrying their own copy is three copies that drift, and the one that
   * drifts is the one that gives medical advice at 3am.
   *
   * @param {Object} variables - Per-call variable values
   * @param {string} [mode=outbound]
   * @returns {string}
   */
  buildSystemPrompt(variables, mode = 'outbound') {
    // DISABLE_GUARDRAILS is a debugging escape hatch, deliberately built as a
    // flag rather than by deleting the guardrail text: nothing is lost, and it
    // announces itself every single time it is used.
    //
    // With it set, the agent will not run the medical-emergency sequence, will
    // not escalate a reported symptom, and may give medical advice. It must
    // never be set for a call to a real number or for any recorded run.
    const guardrailsDisabled = process.env.DISABLE_GUARDRAILS === 'true';
    if (guardrailsDisabled) {
      logger.log('GUARDRAILS_DISABLED', {
        mode,
        warning:
          'Safety guardrails are NOT in this prompt. No symptom escalation, no ' +
          'emergency sequence. Debug use only — never a real caller.',
      });
    }

    return this._composeWithGuardrails(this.getModeBlock(mode).system_prompt, variables, guardrailsDisabled);
  }

  /**
   * The single place a prompt is assembled.
   *
   * Every prompt this agent ever speaks behind — the three call modes AND every
   * squad member — goes through here, so guardrails cannot be omitted by
   * building a prompt some other way. That matters more for a squad than for a
   * single assistant: one missing block in one of a dozen members is a member
   * that will give medical advice, and it looks exactly like the others.
   *
   * @private
   * @param {string} leadBlock - the mode block or the member's goal block
   * @param {Object} variables
   * @param {boolean} guardrailsDisabled
   * @returns {string}
   */
  _composeWithGuardrails(leadBlock, variables, guardrailsDisabled) {
    const composed = [
      leadBlock,
      this.config.shared_rules,
      guardrailsDisabled ? null : this.config.guardrails,
    ]
      .filter(Boolean)
      .join('\n\n');

    const vars = { ...this.config.variables, ...variables };
    return this._substitute(composed, { ...vars, alert_delivered_line: this._resolveAlertDeliveredLine(vars) });
  }

  /**
   * Build the squad members for a call: the multi-state form of the prompt.
   *
   * Each member's prompt goes through _composeWithGuardrails, the SAME path
   * buildSystemPrompt uses — so a member physically cannot exist without the
   * safety block. That is asserted in tests rather than trusted.
   *
   * Globals (emergency, opt-out) are appended as destinations on every
   * non-terminal member, so an emergency reported during the wellbeing question
   * exits as surely as one reported at the greeting.
   *
   * @param {Object} variables - per-call variable values
   * @returns {Array<{key,label,first,terminal,systemPrompt,destinations}>}
   */
  buildSquadMembers(variables = {}) {
    const guardrailsDisabled = process.env.DISABLE_GUARDRAILS === 'true';
    if (guardrailsDisabled) {
      logger.log('GUARDRAILS_DISABLED', {
        mode: 'squad',
        warning:
          'Safety guardrails are NOT in these member prompts. No symptom escalation, ' +
          'no emergency sequence. Debug use only — never a real caller.',
      });
    }

    const byKey = new Map(MEMBERS.map((m) => [m.key, m]));

    return MEMBERS.map((member) => {
      const destinations = [...member.destinations];

      // Globals reach every member that can still transition. A terminal
      // member (close, emergency, opt_out) is where the call ends; giving it
      // an escape hatch would let the agent leave a completed emergency.
      if (!member.terminal) {
        for (const key of GLOBAL_MEMBERS) {
          if (key === member.key) continue;
          destinations.push({ to: key, description: GLOBAL_DESTINATIONS[key] });
        }
      }

      for (const d of destinations) {
        if (!byKey.has(d.to)) {
          throw new Error(
            `Squad member "${member.key}" points at unknown member "${d.to}" — ` +
              'a dangling destination is a dead end mid-call.'
          );
        }
      }

      return {
        key: member.key,
        label: member.label,
        first: Boolean(member.first),
        terminal: Boolean(member.terminal),
        systemPrompt: this._composeWithGuardrails(member.goal, variables, guardrailsDisabled),
        destinations: destinations.map((d) => ({
          to: d.to,
          label: byKey.get(d.to).label,
          description: d.description,
        })),
      };
    });
  }

  /**
   * Resolve the delivery-conditioned escalation line (see config.guardrails).
   *
   * The caregiver alert fires AFTER the call ends (EscalationAlertPlugin), so
   * at the moment the agent is speaking it can never truthfully claim
   * delivery already happened. `alert_delivered` defaults to false in every
   * config, which is what makes the honest "trying to reach" phrasing the
   * one that actually gets said.
   *
   * @private
   */
  _resolveAlertDeliveredLine(vars) {
    const line = vars.alert_delivered ? vars.alert_delivered_true_line : vars.alert_delivered_false_line;
    return this._substitute(line || '', vars);
  }

  /**
   * @param {Object} variables - Per-call variable values
   * @param {string} [mode=outbound]
   * @returns {string}
   */
  buildFirstMessage(variables, mode = 'outbound') {
    return this._tidy(
      this._substitute(this.getModeBlock(mode).first_message, {
        ...this.config.variables,
        ...variables,
      })
    );
  }

  /**
   * Close the gaps an empty variable leaves behind.
   *
   * Applied to first messages ONLY. System prompts are multi-line YAML blocks
   * whose indentation is meaningful, so collapsing whitespace there would
   * mangle them.
   *
   * @private
   */
  _tidy(text) {
    return text
      .replace(/ {2,}/g, ' ')
      .replace(/\s+([.,?!।])/g, '$1')
      .trim();
  }

  /**
   * Replace {placeholder} tokens.
   * @private
   */
  _substitute(text, vars) {
    let out = text;
    for (const [key, value] of Object.entries(vars || {})) {
      out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
    }
    return out;
  }

  getTools() {
    return TOOLS;
  }

  deriveOutcome(callData) {
    return deriveOutcome(callData);
  }

  shouldEscalate(outcome) {
    return outcome.label === OUTCOMES.ESCALATED_SYMPTOM || outcome.label === OUTCOMES.ESCALATED_DISTRESS;
  }

  getConfig() {
    return {
      version: this.config.version,

      // Silence handling. The caller is elderly and may take 5-8 seconds to
      // process a question and answer, so silence must be answered by a gentle
      // re-prompt, not by hanging up. Vapi's customer.speech.timeout hooks do
      // the prompting; silenceTimeoutSeconds is only the hard backstop and MUST
      // stay above idleEndSeconds or the call dies before the hooks finish.
      // Vapi's own guidance is to allow 2-3s of audio processing on top of each
      // configured timeout, so 6 here lands nearer 8-9s in practice.
      idlePromptSeconds: 6,
      idleEscalateSeconds: 14,
      idleEndSeconds: 24,
      silenceTimeoutSeconds: 30,

      maxDurationSeconds: 180,

      // Off, not 'office'. An office ambience under a call to a possibly
      // hard-of-hearing elderly patient costs intelligibility and contradicts
      // the persona; it buys nothing back.
      backgroundSound: 'off',
      denoiseEnabled: true,
      temperature: 0.3,
      maxTokens: 250,
    };
  }

  getVariables() {
    return this.config.variables || {};
  }

  getPromptVersion() {
    return this.config.version;
  }
}

module.exports = MedicationAdherenceStrategy;
