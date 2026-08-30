'use strict';

/**
 * Boot-time safety guard.
 *
 * Three of this service's protections default to OFF when unconfigured:
 *
 *   - `apiKeyAuth` (core/middleware/auth.js) skips authentication entirely when
 *     API_KEY is unset, so every PHI route answers anyone.
 *   - `DISABLE_GUARDRAILS` strips the whole SR-1..SR-4 safety block out of the
 *     composed system prompt, leaving an agent with no emergency sequence, no
 *     anti-diagnosis rule, and nothing forbidding a claim that help was
 *     dispatched.
 *   - `VAPI_SECRET` (core/middleware/auth.js's vapiSecretAuth) guards /webhook,
 *     /llm/chat/completions, /api/tts/:provider and the /api/stt WebSocket —
 *     the four endpoints Vapi must reach without an operator API key. Unset,
 *     they are open to the internet: a forged webhook writes fake rows into
 *     `calls`, and the STT/LLM bridges are a paid-vendor-call amplifier for
 *     anyone who finds the URL.
 *
 * All three are useful locally and catastrophic in production, and none
 * announces itself: auth-off logs nothing, a guardrail-free prompt is still
 * valid, still fluent, still answers the phone, and an unauthenticated webhook
 * looks identical to Vapi's own traffic. An audit found the first two set that
 * way in a working .env at the same time.
 *
 * So the check happens at boot, where it costs one restart instead of one
 * caller. This mirrors assertPersistenceSatisfied() — the only other guard in
 * this codebase that refuses to start rather than warning into a log nobody
 * tails while a phone call is in progress.
 *
 * The single opt-out is deliberately one greppable variable rather than a
 * per-protection flag: ALLOW_INSECURE_LOCAL is absent from .env.example, the
 * Dockerfile and docker-compose.yml, so a deployment that inherits any of those
 * fails closed. Forgetting to set something is safe; only an explicit choice is
 * unsafe.
 */

const OPT_OUT = 'ALLOW_INSECURE_LOCAL';

/**
 * Anything but unset/empty/'false'/'0' counts as on.
 *
 * strategy.js strips guardrails on the narrower `=== 'true'`, so a value like
 * `1` blocks boot without actually disabling guardrails. That asymmetry is
 * intentional: over-refusing to start is recoverable, serving an unguarded
 * agent is not.
 */
function isOn(value) {
  if (value === undefined || value === null) return false;
  const normalised = String(value).trim().toLowerCase();
  if (normalised === '' || normalised === 'false' || normalised === '0') return false;
  return true;
}

/**
 * Throw unless it is safe to serve traffic.
 *
 * @param {Object} [env] - Environment to read; defaults to process.env
 * @throws {Error} Listing every unmet condition and the variable that fixes it
 */
function assertSafeToServe(env = process.env) {
  if (isOn(env[OPT_OUT])) return;

  const failures = [];

  if (!env.API_KEY) {
    failures.push(
      'API_KEY is not set, so apiKeyAuth serves every /api route unauthenticated ' +
        '(patient names, phone numbers, transcripts). Set API_KEY to a shared secret.'
    );
  }

  if (!env.VAPI_SECRET) {
    failures.push(
      'VAPI_SECRET is not set, so /webhook, /llm/chat/completions, /api/tts/:provider ' +
        'and the /api/stt WebSocket accept anyone — a forged webhook can write fake ' +
        'call rows, and the bridged endpoints are a free paid-vendor-call amplifier. ' +
        'Set VAPI_SECRET to a shared secret and configure it on the Vapi assistant/phone ' +
        'number as well.'
    );
  }

  if (isOn(env.DISABLE_GUARDRAILS)) {
    failures.push(
      'DISABLE_GUARDRAILS is set, so the composed prompt carries no medical-emergency ' +
        'sequence, no distress sequence, and no rule against claiming help was dispatched. ' +
        'Unset it, or set it to false.'
    );
  }

  if (failures.length === 0) return;

  throw new Error(
    `Refusing to start — ${failures.length} safety protection(s) are disabled:\n` +
      failures.map((f) => `  - ${f}`).join('\n') +
      `\nFor local work where this is intended, set ${OPT_OUT}=1. Never set it in a deployment.`
  );
}

module.exports = { assertSafeToServe, OPT_OUT };
