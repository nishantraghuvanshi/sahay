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

/** True when ALLOW_INSECURE_LOCAL is on for the given env. Single source of
 * truth for that check — server.js needs the same answer to decide whether
 * to log the loud auth_disabled line every boot. */
function isInsecureLocalOn(env = process.env) {
  return isOn(env[OPT_OUT]);
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
  // Checked before the OPT_OUT short-circuit below: a missing transport
  // argument is a programming-error guard, not a security check, and
  // ALLOW_INSECURE_LOCAL must never swallow a call site that forgot to
  // resolve the active transport first.
  if (!transport || typeof transport.requiredSecrets !== 'function') {
    throw new Error(
      'assertSafeToServe() needs the resolved active transport to know which ' +
        'secret(s) guard it — pass it as the second argument.'
    );
  }

  if (isInsecureLocalOn(env)) return;

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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).trim().toLowerCase());
}

/**
 * Resolve the host to bind the HTTP server to.
 *
 * ALLOW_INSECURE_LOCAL disables API_KEY enforcement, the transport's own
 * secret checks, and operator alerting — and this project routinely exposes
 * the server through a public tunnel. A process with those checks off and no
 * host restriction is one tunnel restart away from an open PHI endpoint, so
 * insecure mode may only ever bind loopback:
 *
 *   - HOST unset: default to 127.0.0.1 rather than Node's normal
 *     "all interfaces" default. Safe by omission — a developer who never
 *     thinks about HOST still gets a local-only bind.
 *   - HOST set to a loopback address/name: pass it through.
 *   - HOST set to anything else: refuse to start. An explicit request to
 *     bind a network interface while insecure must fail loudly, not succeed
 *     silently with the checks it asked to skip.
 *
 * When ALLOW_INSECURE_LOCAL is off, HOST passes through unchanged (including
 * unset, which keeps today's default of all interfaces) — this function only
 * constrains the insecure case.
 *
 * @param {Object} [env] - Environment to read; defaults to process.env
 * @returns {string|undefined} The host to bind, or undefined for Node's default
 * @throws {Error} When insecure mode is on and HOST names a non-loopback address
 */
function resolveBindHost(env = process.env) {
  const requestedHost = env.HOST;

  if (!isInsecureLocalOn(env)) return requestedHost;

  if (requestedHost && !isLoopbackHost(requestedHost)) {
    throw new Error(
      `Refusing to start — ${OPT_OUT} is set and HOST=${requestedHost} is not loopback. ` +
        `Insecure mode may only bind 127.0.0.1, localhost, or ::1, because API_KEY, the ` +
        `transport's own secrets and operator alerting are all disabled and this project ` +
        `routinely exposes the server through a public tunnel. Unset HOST, set it to ` +
        `127.0.0.1, or turn off ${OPT_OUT}.`
    );
  }

  return requestedHost || '127.0.0.1';
}

module.exports = { assertSafeToServe, resolveBindHost, isInsecureLocalOn, OPT_OUT };
