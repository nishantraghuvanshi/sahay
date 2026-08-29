'use strict';

/**
 * Plugin Registry
 *
 * Plugins are optional capabilities that subscribe to domain events
 * and can contribute to outcomes, expose tools, and intercept transcripts.
 *
 * A plugin is any object with some of these optional methods:
 *   - onConversationStart(ctx)
 *   - onConversationEnd(ctx)
 *   - onTranscript(event, ctx) → can transform or annotate
 *   - onOutcomeDerive(ctx) → can contribute to outcome
 *   - tools → array of tool definitions to expose to the LLM
 *
 * Example plugins:
 *   - TriageClassifier: detects emergency symptoms in transcripts
 *   - BiomarkerAnalyzer: analyzes voice patterns for distress
 *   - CaregiverNotifier: sends SMS/WhatsApp on escalation
 *   - AuditLogger: logs every event for compliance
 */
class PluginRegistry {
  constructor() {
    this.plugins = [];
  }

  /**
   * Register a plugin.
   * @param {Object} plugin - Plugin object with optional lifecycle hooks
   */
  register(plugin) {
    if (!plugin.name) {
      throw new Error('Plugin must have a "name" property');
    }
    this.plugins.push(plugin);
    console.log(JSON.stringify({
      event: 'plugin_registered',
      plugin: plugin.name,
      // Walk the prototype too — class methods are not own properties, so
      // Object.keys() alone reports an empty hook list for a class-based plugin.
      hooks: listHooks(plugin),
    }));
  }

  /**
   * Get all tools from all registered plugins.
   * @returns {Array} Tool definitions
   */
  getAllTools() {
    return this.plugins.flatMap(p => p.tools || []);
  }

  /**
   * Call a lifecycle hook on all plugins that implement it.
   * @param {string} hookName - e.g., 'onConversationStart'
   * @param {...any} args - Arguments to pass to the hook
   */
  async callHook(hookName, ...args) {
    for (const plugin of this.plugins) {
      if (typeof plugin[hookName] === 'function') {
        try {
          await plugin[hookName](...args);
        } catch (e) {
          console.error(JSON.stringify({
            event: 'plugin_hook_error',
            plugin: plugin.name,
            hook: hookName,
            error: e.message,
          }));
        }
      }
    }
  }
}

/**
 * Collect hook names from own properties and the prototype chain.
 * @private
 */
function listHooks(plugin) {
  const names = new Set();
  for (let o = plugin; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k.startsWith('on') || k === 'tools') names.add(k);
    }
  }
  return [...names];
}

module.exports = PluginRegistry;
