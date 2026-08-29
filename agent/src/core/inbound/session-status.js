'use strict';

/** endedReason values Vapi reports for a normal, assistant/customer-driven hangup. */
const NORMAL_ENDED_REASONS = new Set([
  'customer-ended-call',
  'assistant-ended-call',
  'assistant-ended-call-with-hangup-task',
]);

/**
 * Decide the terminal session status for a finished call.
 *
 * An unknown or absent reason defaults to `dropped`, never `completed`:
 * a wrongly-dropped session is merely resumable, while a wrongly-completed
 * one is silently unresumable — the exact failure this plan exists to remove.
 *
 * @param {string|undefined} endedReason - Vapi's `call.endedReason`
 * @returns {'completed'|'dropped'}
 */
function terminalStatusFor(endedReason) {
  const isAssistantHangup = typeof endedReason === 'string'
    && endedReason.startsWith('assistant-')
    && endedReason.includes('hangup');

  if (endedReason && (NORMAL_ENDED_REASONS.has(endedReason) || isAssistantHangup)) {
    return 'completed';
  }
  return 'dropped';
}

module.exports = { terminalStatusFor };
