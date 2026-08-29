'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const ConversationStrategy = require('../../core/strategy/base');
const { deriveOutcome, OUTCOMES } = require('./outcomes');
const { TOOLS } = require('./tools');

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
    const composed = [
      this.getModeBlock(mode).system_prompt,
      this.config.shared_rules,
      this.config.guardrails,
    ]
      .filter(Boolean)
      .join('\n\n');

    const vars = { ...this.config.variables, ...variables };
    return this._substitute(composed, { ...vars, alert_delivered_line: this._resolveAlertDeliveredLine(vars) });
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
      silenceTimeoutSeconds: 15,
      maxDurationSeconds: 90,
      maxIdleSeconds: 30,
      backgroundSound: 'office',
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
