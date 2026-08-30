'use strict';

const logger = require('../../utils/logger');
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
// The language whose prompt is actually maintained. Everything else is checked
// against it and refused if it trails.
const BASELINE_LANGUAGE = 'hi';
const BASELINE_CONFIG = 'medication-adherence.yaml';

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

    // Refuse a language whose prompt has fallen behind the one actually being
    // maintained. On 30 August the English config sat at version 6 while Hindi
    // reached 16: an English call would have narrated the model's reasoning
    // aloud, claimed to be contacting the family when it was not, and read
    // "maybe" as a taken dose — every defect that day removed.
    //
    // Nothing caught it. The parity test was green the whole time, because it
    // matches guardrail LABELS and a label is not a behaviour.
    //
    // Failing here is deliberate. The alternative to a loud boot failure is a
    // quiet call to a patient with ten versions of missing safety work, and
    // between those two the choice is not close.
    if (language !== BASELINE_LANGUAGE) {
      const baseline = yaml.load(
        fs.readFileSync(
          path.join(__dirname, '../../../config/use-cases/', BASELINE_CONFIG),
          'utf8'
        )
      );
      if (Number(this.config.version) < Number(baseline.version)) {
        throw new Error(
          `The ${language} prompt is at version ${this.config.version} while ` +
            `${BASELINE_LANGUAGE} is at ${baseline.version}. It is missing every prompt ` +
            `fix made since, so it must not be used on a call. Port ` +
            `${configFile} up to version ${baseline.version} — see the warning at the ` +
            `top of that file for what is involved — or run in ${BASELINE_LANGUAGE}.`
        );
      }
    }
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

    const composed = [
      this.getModeBlock(mode).system_prompt,
      this.config.shared_rules,
      guardrailsDisabled ? null : this.config.guardrails,
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
      maxDurationSeconds: 180,
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
