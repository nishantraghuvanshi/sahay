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
 *   - The active transport's own secret(s) — VAPI_SECRET for Vapi,
 *     ELEVENLABS_WEBHOOK_SECRET and ELEVENLABS_POST_CALL_SECRET for
 *     ElevenLabs — guard its webhooks and bridged endpoints. Unset, they are
 *     open to the internet: a forged webhook writes fake rows into `calls`,
 *     bridged endpoints are a paid-vendor-call amplifier for anyone who finds
 *     the URL, and for ElevenLabs specifically every server-tool call 401s —
 *     including the one that files ESCALATED_SYMPTOM, so a chest-pain report
 *     never reaches a caregiver. This guard asks the resolved transport via
 *     `TransportPort#requiredSecrets()` rather than naming one vendor, so it
 *     checks whichever transport is actually configured active.
 *
 *   - `ALERT_OPERATOR_CONTACT` (use-cases/medication-adherence/plugins/
 *     escalation-alert.js) is where ESCALATED_SYMPTOM/ESCALATED_DISTRESS
 *     alerts go. .env.example already says unset means escalations are
 *     "logged loudly but NOBODY is notified" — the same defect class as the
 *     checks above: the call is recorded, the family just never hears it.
 *
 * All are useful locally and catastrophic in production, and none announces
 * itself: auth-off logs nothing, a guardrail-free prompt is still valid,
 * still fluent, still answers the phone, and an unauthenticated webhook
 * looks identical to real transport traffic. An audit found the first two
 * set that way in a working .env at the same time.
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
 * @param {Object} transport - The resolved active TransportPort. Required:
 *   this is the whole point of the check — it must ask the transport that
 *   will actually serve traffic which secrets it needs, not assume one.
 * @throws {Error} Listing every unmet condition and the variable that fixes it
 */
function assertSafeToServe(env = process.env, transport) {
  if (isOn(env[OPT_OUT])) return;

  if (!transport || typeof transport.requiredSecrets !== 'function') {
    throw new Error(
      'assertSafeToServe() needs the resolved active transport to know which ' +
        'secret(s) guard it — pass it as the second argument.'
    );
  }

  const failures = [];

  if (!env.API_KEY) {
    failures.push(
      'API_KEY is not set, so apiKeyAuth serves every /api route unauthenticated ' +
        '(patient names, phone numbers, transcripts). Set API_KEY to a shared secret.'
    );
  }

  for (const secret of transport.requiredSecrets()) {
    if (!env[secret.name]) {
      failures.push(`${secret.name} is not set — ${secret.why} Set ${secret.name}.`);
    }
  }

  if (isOn(env.DISABLE_GUARDRAILS)) {
    failures.push(
      'DISABLE_GUARDRAILS is set, so the composed prompt carries no medical-emergency ' +
        'sequence, no distress sequence, and no rule against claiming help was dispatched. ' +
        'Unset it, or set it to false.'
    );
  }

  if (!env.ALERT_OPERATOR_CONTACT) {
    failures.push(
      'ALERT_OPERATOR_CONTACT is not set, so ESCALATED_SYMPTOM/ESCALATED_DISTRESS ' +
        'alerts are logged loudly but nobody is notified — the call is recorded and the ' +
        'family never hears about it. Set ALERT_OPERATOR_CONTACT to the operator chat id.'
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
