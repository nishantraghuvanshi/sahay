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

  buildSystemPrompt(variables) {
    // Substitute variables into system prompt
    let prompt = this.config.system_prompt;
    for (const [key, value] of Object.entries(variables || {})) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return prompt;
  }

  buildFirstMessage(variables) {
    let message = this.config.first_message;
    const vars = { ...this.config.variables, ...variables };
    for (const [key, value] of Object.entries(vars)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return message;
  }

  getTools() {
    return TOOLS;
  }

  deriveOutcome(callData) {
    return deriveOutcome(callData);
  }

  shouldEscalate(outcome) {
    return outcome.label === OUTCOMES.ESCALATED_SYMPTOM;
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
