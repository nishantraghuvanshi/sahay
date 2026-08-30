'use strict';
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const API = 'https://api.elevenlabs.io';

/**
 * Register the workspace-level post-call webhook.
 *
 * ElevenLabs does not accept a webhook URL directly on an agent — the URL
 * lives on a workspace-level webhook object (POST /v1/workspace/webhooks),
 * and the agent only ever references it by id, via
 * conversation_config.platform_settings.workspace_overrides.webhooks
 * (see buildAssistantConfig in src/adapters/transport/elevenlabs.js). This
 * script creates that workspace object; it does not touch any agent.
 *
 * `auth_type: 'hmac'` is not a choice — the OpenAPI spec defines it as a
 * const, the only value the endpoint accepts. `request_headers` carries our
 * own shared-secret header instead, matching the check the /el/post-call
 * route already runs (see elevenlabs.js's `/el/post-call` handler).
 *
 * Run once per environment. The printed id is a one-time output: paste it
 * into agent/.env as ELEVENLABS_POST_CALL_WEBHOOK_ID and buildAssistantConfig
 * picks it up on the next boot-time agent patch.
 */
async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Missing env var: ELEVENLABS_API_KEY');

  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) throw new Error('Missing env var: WEBHOOK_URL');

  const res = await fetch(`${API}/v1/workspace/webhooks`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings: {
        auth_type: 'hmac',
        name: 'Kinvox post-call',
        webhook_url: `${webhookUrl}/el/post-call`,
        request_headers: { 'X-Kinvox-Token': process.env.ELEVENLABS_WEBHOOK_SECRET },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`webhook create failed (${res.status}): ${await res.text()}`);
  }

  const body = await res.json();
  // Field name assumed from ElevenLabs' id-naming convention elsewhere in the
  // API (agent_id, phone_number_id, conversation_id); not independently
  // confirmed against a live response since this script must not be run
  // here. If the API actually returns a different key, this will print
  // `undefined` — check the raw response body before pasting anything.
  const id = body.webhook_id;
  if (!id) {
    console.error('Webhook created, but no webhook_id found in the response. Raw response:');
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`\nRegistered. Put this in your .env:\n\n  ELEVENLABS_POST_CALL_WEBHOOK_ID=${id}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
