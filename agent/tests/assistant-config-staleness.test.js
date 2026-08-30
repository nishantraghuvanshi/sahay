'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  generate,
  redactSecrets,
  redactWebhookUrl,
  substituteWebhookUrl,
  WEBHOOK_URL_PLACEHOLDER,
} = require('../scripts/generate-assistant-config');

/**
 * config/assistant.json is what create-assistant.js / update-assistant.js PATCH
 * to the LIVE Vapi assistant — it is the prompt that actually answers the phone.
 *
 * It shipped once as a byte-for-byte copy of a DISABLE_GUARDRAILS=true build:
 * the entire SR-1..SR-4 block absent, while the CALL FLOW section still told
 * the model to "follow the matching sequence in your guardrails" — a dangling
 * reference to text that was not in the file. A debug flag left set in one
 * local .env had walked into a committed deployable, and nothing caught it,
 * because the file was still valid JSON with a full prompt and a full tool list.
 *
 * tools.json already had a staleness test (tests/generate-tools.test.js). This
 * is the same guard applied to the higher-stakes artifact — the pattern existed,
 * it just had not been pointed at the file where a miss reaches a patient.
 *
 * The guardrail assertions below are deliberately not a substitute for the
 * staleness check: staleness catches drift, and the explicit assertions state
 * WHICH clauses may never silently disappear, so a regression names itself.
 */

const ASSISTANT_JSON = path.join(__dirname, '..', 'config', 'assistant.json');

function systemPromptOf(config) {
  const message = config.model.messages.find((m) => m.role === 'system');
  assert.ok(message, 'assistant config should carry a system message');
  return message.content;
}

describe('committed config/assistant.json is not stale', () => {
  test('assistant.json exists', () => {
    assert.ok(fs.existsSync(ASSISTANT_JSON), 'config/assistant.json should exist');
  });

  test('matches what the generator would write', () => {
    const onDisk = JSON.parse(fs.readFileSync(ASSISTANT_JSON, 'utf8'));
    const { assistantConfig, webhookUrl } = generate();
    // Compare against the redacted form: the committed file deliberately
    // carries a placeholder where VAPI_SECRET goes, so that a tracked, soon
    // to be public artifact never holds the live secret — and a placeholder
    // where THIS reader's WEBHOOK_URL goes, so the file matches every
    // developer's .env, not just whoever last ran the generator. Without
    // this the staleness check would pressure the real secret, or one
    // developer's own webhook URL, into the repo.
    assert.deepStrictEqual(
      onDisk,
      redactWebhookUrl(redactSecrets(assistantConfig), webhookUrl),
      'config/assistant.json is stale — run `node scripts/generate-assistant-config.js`'
    );
  });
});

describe('the committed config carries no developer\'s environment', () => {
  test('contains no hostname — every WEBHOOK_URL-derived field is the placeholder', () => {
    const raw = fs.readFileSync(ASSISTANT_JSON, 'utf8');
    // The placeholder itself contains no "://", so any surviving http(s) URL
    // means a concrete host slipped in — a developer's tunnel origin, a
    // teammate's domain, whatever whoever last ran the generator had in
    // their .env.
    assert.ok(
      !/https?:\/\//.test(raw),
      'config/assistant.json contains what looks like a concrete hostname — it should carry ' +
        `only the ${WEBHOOK_URL_PLACEHOLDER} placeholder for every WEBHOOK_URL-derived field`
    );
    assert.ok(raw.includes(WEBHOOK_URL_PLACEHOLDER), 'expected the webhook URL placeholder to be present');
  });

  test('substituting a webhook URL back in reproduces the previous concrete output', () => {
    const onDisk = JSON.parse(fs.readFileSync(ASSISTANT_JSON, 'utf8'));
    const webhookUrl = 'https://voice.voxikin.com';
    const restored = substituteWebhookUrl(onDisk, webhookUrl);
    assert.ok(
      JSON.stringify(restored).includes(webhookUrl),
      'substituteWebhookUrl should put a concrete webhook URL back into every placeholder field'
    );
    assert.ok(
      !JSON.stringify(restored).includes(WEBHOOK_URL_PLACEHOLDER),
      'no placeholder should survive substitution'
    );
    // Round-trip: redacting the restored config with the same URL should
    // reproduce exactly what is committed on disk.
    assert.deepStrictEqual(redactWebhookUrl(restored, webhookUrl), onDisk);
  });
});

describe('the deployed prompt carries its safety guardrails', () => {
  // Each entry is a clause whose absence would change what the agent may say to
  // an elderly caller in an emergency. Matched case-insensitively against the
  // committed file, not against a fresh generation, so this fails if the
  // artifact on disk is unsafe even when the source is fine.
  const REQUIRED_CLAUSES = [
    'GUARDRAILS',
    'NON-NEGOTIABLE',
    'MEDICAL EMERGENCY',
    'EMOTIONAL DISTRESS',
    'ambulance',
    'diagnose',
    'dosage',
  ];

  const prompt = () => systemPromptOf(JSON.parse(fs.readFileSync(ASSISTANT_JSON, 'utf8')));

  for (const clause of REQUIRED_CLAUSES) {
    test(`retains the "${clause}" guardrail text`, () => {
      assert.ok(
        prompt().toLowerCase().includes(clause.toLowerCase()),
        `config/assistant.json is missing "${clause}". It was probably generated with ` +
          'DISABLE_GUARDRAILS set. Regenerate with the flag unset before committing.'
      );
    });
  }

  test('is not the guardrails-stripped build', () => {
    // The stripped build measured 3997 characters against 6485 with guardrails
    // on. An exact length assertion would break on every prompt edit, so this
    // asserts the floor the block cannot be removed without crossing.
    assert.ok(
      prompt().length > 5000,
      `system prompt is ${prompt().length} chars — short enough to suggest the ` +
        'guardrail block was stripped. Regenerate with DISABLE_GUARDRAILS unset.'
    );
  });

  test('does not reference guardrails it lacks', () => {
    // The specific failure that shipped: CALL FLOW pointed at "your guardrails"
    // while the block itself was absent, so the model had a dangling reference
    // and improvised its emergency behaviour.
    const text = prompt();
    if (/your guardrails/i.test(text)) {
      assert.ok(
        /GUARDRAILS/i.test(text),
        'prompt refers to "your guardrails" but contains no guardrail block'
      );
    }
  });
});

describe('the committed config never carries a live secret', () => {
  test('no secret-bearing field holds anything but the placeholder', () => {
    const raw = fs.readFileSync(ASSISTANT_JSON, 'utf8');
    const { REDACTED_SECRET } = require('../scripts/generate-assistant-config');
    const secrets = [
      ...raw.matchAll(/"secret"\s*:\s*"([^"]*)"/g),
      ...raw.matchAll(/"x-vapi-secret"\s*:\s*"([^"]*)"/g),
      ...raw.matchAll(/api_key=([^"&]*)/g),
    ].map((m) => m[1]);

    for (const value of secrets) {
      assert.ok(
        value === '' || value === REDACTED_SECRET,
        `config/assistant.json contains what looks like a live secret (${value.slice(0, 6)}...). ` +
          'It is tracked and this repo goes public — regenerate so it is redacted.'
      );
    }
  });

  test('the generator actually replaces a live secret when one is set', () => {
    const { redactSecrets, REDACTED_SECRET } = require('../scripts/generate-assistant-config');
    const sample = { server: { url: 'https://x/webhook?api_key=s3cr3t', secret: 's3cr3t' } };
    const out = redactSecrets(sample, 's3cr3t');
    assert.strictEqual(out.server.secret, REDACTED_SECRET);
    assert.ok(!JSON.stringify(out).includes('s3cr3t'), 'secret survived redaction');
  });
});
