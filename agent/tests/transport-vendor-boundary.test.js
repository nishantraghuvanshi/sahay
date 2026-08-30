'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Task 2's guard rail: no file outside src/adapters/transport/ may name a
 * vendor — no VAPI_ or ELEVENLABS_ env read, no api.vapi.ai / api.elevenlabs.io
 * host. That is exactly the class of bug this task fixed twice (dialPatient
 * reading VAPI_ASSISTANT_ID directly, GET /api/call/:callId fetching
 * api.vapi.ai directly): a caller resolves a vendor detail itself instead of
 * asking the active transport, so it silently misbehaves — or works by
 * accident — the moment a different transport is active.
 *
 * Scope and known blind spots (read before trusting a green run here):
 *   - Only scans agent/src/**\/*.js. Doesn't touch agent/scripts/,
 *     agent/tests/, config/, or docs — a leak there is real but out of what
 *     this guard checks.
 *   - Skips `//` line comments and `/* *\/` block comments (including
 *     multi-line JSDoc), so prose explaining a vendor variable's name (e.g.
 *     TransportPort#getAssistantId's own docstring) doesn't trip it. A vendor
 *     name inside a template string or a multi-statement line that also
 *     contains "//" earlier in the same line would be missed — this
 *     codebase's style doesn't do either, but a future file that did would
 *     slip past.
 *   - Explicit, justified exceptions below for two pre-existing files that
 *     are out of this task's scope (see ALLOWED_EXCEPTIONS) — this guard
 *     enforces the boundary this task drew, not a blanket "zero vendor
 *     strings anywhere" rule.
 *   - Matches on token shape (VAPI_[A-Z_]+, ELEVENLABS_[A-Z_]+, the two
 *     hostnames), not on semantics — a variable merely named similarly
 *     (unlikely, but possible) would false-positive; that's an acceptable
 *     trade for a bare-metal grep-shaped check.
 */

const SRC_ROOT = path.join(__dirname, '..', 'src');
const ADAPTER_DIR = path.join(SRC_ROOT, 'adapters', 'transport') + path.sep;

// Pre-existing vendor integrations outside the TransportPort boundary that
// this task did not touch and is not scoped to fix:
//   - core/middleware/auth.js: Vapi's own webhook-signature verification
//     (vapiSecretAuth / verifyVapiSecret / authenticateVapiWebSocket) — a
//     different concern from dialling or polling a call through
//     TransportPort, and not one of the two leaks this task's brief named.
//   - use-cases/medication-adherence/demo-call.js: an ElevenLabs-only demo
//     call path that never goes through TransportPort at all.
const ALLOWED_EXCEPTIONS = new Set([
  path.join(SRC_ROOT, 'core', 'middleware', 'auth.js'),
  path.join(SRC_ROOT, 'use-cases', 'medication-adherence', 'demo-call.js'),
]);

const VENDOR_PATTERN = /\bVAPI_[A-Z_]+\b|\bELEVENLABS_[A-Z_]+\b|api\.vapi\.ai|api\.elevenlabs\.io/;

/** Strips a trailing `// ...` line comment. Good enough: this codebase never
 * puts a vendor name in a string literal that also contains "//" earlier on
 * the same line. */
function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function listJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Vendor-name matches in `content`, line by line, with `//` and `/* *\/`
 * (including multi-line block/JSDoc) comments stripped first.
 */
function findVendorMatches(content) {
  const matches = [];
  let inBlockComment = false;
  const lines = content.split('\n');

  lines.forEach((rawLine, i) => {
    let line = rawLine;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // Block comments that both open and close on this same line.
    line = line.replace(/\/\*.*?\*\//g, '');
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      inBlockComment = true;
      line = line.slice(0, blockStart);
    }
    line = stripLineComment(line);

    if (VENDOR_PATTERN.test(line)) {
      matches.push(`${i + 1}: ${rawLine.trim()}`);
    }
  });

  return matches;
}

function findVendorLeaks() {
  const leaks = [];
  for (const file of listJsFiles(SRC_ROOT)) {
    if (file.startsWith(ADAPTER_DIR)) continue;
    if (ALLOWED_EXCEPTIONS.has(file)) continue;

    const matches = findVendorMatches(fs.readFileSync(file, 'utf8'));
    for (const m of matches) {
      leaks.push(`${path.relative(SRC_ROOT, file)}:${m}`);
    }
  }
  return leaks;
}

describe('transport vendor boundary', () => {
  test('no file outside adapters/transport/ (and the listed exceptions) names a vendor env var or host', () => {
    const leaks = findVendorLeaks();
    assert.deepStrictEqual(leaks, [], `vendor leak(s) found outside the transport boundary:\n${leaks.join('\n')}`);
  });

  test('adapters/transport/ itself is exempt — vendor names there are the point', () => {
    const vapiFile = path.join(ADAPTER_DIR, 'vapi.js');
    const matches = findVendorMatches(fs.readFileSync(vapiFile, 'utf8'));
    assert.ok(matches.length > 0, 'sanity check: vapi.js should legitimately name VAPI_* vars');
  });

  describe('the pattern itself catches what it claims to (mutation check on the matcher, not the tree)', () => {
    test('matches real vendor leaks', () => {
      assert.ok(VENDOR_PATTERN.test('const id = process.env.VAPI_ASSISTANT_ID;'));
      assert.ok(VENDOR_PATTERN.test("await fetch('https://api.vapi.ai/call/' + callId)"));
      assert.ok(VENDOR_PATTERN.test('process.env.ELEVENLABS_AGENT_ID'));
      assert.ok(VENDOR_PATTERN.test('headers.set("x", "https://api.elevenlabs.io/v1")'));
    });

    test('does not match the transport-agnostic replacement code', () => {
      assert.ok(!VENDOR_PATTERN.test('const id = transport.getAssistantId();'));
      assert.ok(!VENDOR_PATTERN.test('await transport.getCallStatus(callId);'));
    });

    test('a line comment naming a vendor var is stripped before matching', () => {
      const line = '  // reading VAPI_ASSISTANT_ID here hardcoded this to one orchestrator';
      assert.strictEqual(VENDOR_PATTERN.test(stripLineComment(line)), false);
    });

    test('findVendorMatches skips a multi-line JSDoc block naming a vendor var', () => {
      const content = [
        '/**',
        ' * VAPI_ASSISTANT_ID and ELEVENLABS_AGENT_ID are named here only in prose.',
        ' */',
        'function real() { return transport.getAssistantId(); }',
      ].join('\n');
      assert.deepStrictEqual(findVendorMatches(content), []);
    });

    test('findVendorMatches still catches real code following a closed block comment on the same line', () => {
      const content = '/* note */ const id = process.env.VAPI_ASSISTANT_ID;';
      assert.strictEqual(findVendorMatches(content).length, 1);
    });
  });
});
