'use strict';
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const SOURCE_AGENT_ID = 'agent_4901m0kzym5pfm7b7y9aprndv6qp';
const API = 'https://api.elevenlabs.io';

/**
 * Duplicate the prior product's agent into one Kinvox owns.
 *
 * We never patch the original: it is English, carries its own 6,640-character
 * prompt, and works. Every later PATCH targets this copy, so the original stays
 * as a reference to diff against.
 */
async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Missing env var: ELEVENLABS_API_KEY');

  const res = await fetch(`${API}/v1/convai/agents/${SOURCE_AGENT_ID}/duplicate`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Kinvox Dose Call (outbound)' }),
  });
  if (!res.ok) {
    throw new Error(`duplicate failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  const id = body.agent_id;
  console.log(`\nDuplicated. Put this in your .env:\n\n  ELEVENLABS_AGENT_ID=${id}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
