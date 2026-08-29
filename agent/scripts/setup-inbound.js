'use strict';

/**
 * Setup Inbound Hotline
 *
 * Configures a Twilio number to route inbound calls to the Vapi assistant.
 * After running this, anyone who calls the Twilio number will reach the
 * voice agent.
 *
 * There are two ways to connect Twilio to Vapi:
 *   1. Via Vapi dashboard (manual) — connect Twilio account, assign number to assistant
 *   2. Via Twilio API (automated) — set the number's voice URL to Vapi's webhook
 *
 * This script uses approach 2 (Twilio API) for automation, but also prints
 * dashboard instructions for the manual approach.
 *
 * Usage:
 *   node scripts/setup-inbound.js
 *
 * Prerequisites:
 *   - TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN set in .env
 *   - The Vapi number must have NO assistant assigned, so Vapi asks this
 *     server who is calling instead of answering with a static assistant
 *   - TWILIO_PHONE set to your Twilio number (e.g., +1XXXXXXXXXX)
 */

require('dotenv').config();

const TWILIO_BASE = 'https://api.twilio.com';

/**
 * Make an authenticated Twilio API request (HTTP Basic Auth).
 * @param {string} path - API path
 * @param {Object} body - Form-encoded body
 * @param {string} method - HTTP method
 * @returns {Promise<Object>} Parsed JSON response
 */
async function twilioRequest(path, body, method = 'POST') {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env');
  }

  const url = `${TWILIO_BASE}${path}`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const formData = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    formData.append(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * List Twilio phone numbers on the account.
 * @returns {Promise<Array>} List of phone numbers
 */
async function listPhoneNumbers() {
  const result = await twilioRequest(
    `/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`,
    {},
    'GET'
  );
  return result.incoming_phone_numbers || [];
}

/**
 * Update a Twilio number's voice URL to route to Vapi.
 * @param {string} phoneSid - Twilio phone number SID
 * @param {string} voiceUrl - Vapi's Twilio voice webhook URL
 */
async function updateVoiceUrl(phoneSid, voiceUrl) {
  return twilioRequest(
    `/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${phoneSid}.json`,
    {
      VoiceUrl: voiceUrl,
      VoiceMethod: 'POST',
    },
    'POST'
  );
}

async function main() {
  const twilioPhone = process.env.TWILIO_PHONE;
  if (!twilioPhone) {
    console.error('Error: TWILIO_PHONE not set in .env');
    console.error('Set it to your Twilio phone number (e.g., +1XXXXXXXXXX)');
    process.exit(1);
  }

  console.log('Setting up inbound hotline...');
  console.log(`  Twilio number: ${twilioPhone}`);
  console.log('  Assistant: resolved per call via assistant-request');
  console.log('');

  // 1. List Twilio numbers to find the one matching TWILIO_PHONE
  console.log('Fetching Twilio phone numbers...');
  const numbers = await listPhoneNumbers();

  const matchingNumber = numbers.find(
    (n) => n.phone_number === twilioPhone || n.friendly_name === twilioPhone
  );

  if (!matchingNumber) {
    console.error(`Error: Twilio number "${twilioPhone}" not found on your account.`);
    console.error('Available numbers:');
    for (const n of numbers) {
      console.error(`  ${n.phone_number} (SID: ${n.sid})`);
    }
    process.exit(1);
  }

  console.log(`  Found number: ${matchingNumber.phone_number}`);
  console.log(`  SID: ${matchingNumber.sid}`);
  console.log('');

  // 2. The Vapi Twilio voice webhook URL.
  //
  // Deliberately WITHOUT assistantId. Pinning an assistant here makes every
  // inbound call answer with the same static assistant — a second outbound
  // call, greeting a known caller as a stranger. Leaving it off is what makes
  // Vapi send an `assistant-request` to our server instead, so we can look the
  // caller up and answer in inbound or resume mode with their record loaded.
  const vapiVoiceUrl = 'https://api.vapi.ai/twilio/voice';

  console.log('Updating voice URL to route to Vapi...');
  console.log(`  Voice URL: ${vapiVoiceUrl}`);
  console.log('');

  await updateVoiceUrl(matchingNumber.sid, vapiVoiceUrl);

  console.log('Inbound hotline configured successfully!');
  console.log('');
  console.log('=== How it works ===');
  console.log(`1. Someone calls ${twilioPhone}`);
  console.log('2. Twilio sends the call to Vapi via the voice webhook');
  console.log('3. Vapi POSTs an `assistant-request` to this server /webhook');
  console.log('4. We resolve the caller -> patient, and any dropped session');
  console.log('   still inside the resume window, then return an assistant in');
  console.log('   inbound or resume mode with their context loaded');
  console.log('5. End-of-call report is sent back to /webhook');
  console.log('');
  console.log('=== REQUIRED in the Vapi dashboard ===');
  console.log('The number must have NO assistant assigned. If an assistant is');
  console.log('attached, Vapi answers with it directly and never asks us who');
  console.log('is calling — inbound silently degrades to a static greeting.');
  console.log(`Set the number's Server URL to: ${process.env.WEBHOOK_URL || '<WEBHOOK_URL>'}/webhook`);
  console.log('');
  console.log('=== Testing ===');
  console.log(`Call ${twilioPhone} from any phone to test the agent.`);
  console.log('Watch for an `assistant_request_answered` log line — if you see');
  console.log('`webhook_unknown_type` instead, the number still has an assistant.');
  console.log('');
  console.log('=== Manual setup (alternative) ===');
  console.log('If the API approach does not work, you can also set this up manually:');
  console.log('1. Go to Vapi dashboard → Phone Numbers → Import from Twilio');
  console.log('2. Select your Twilio number and assign it to the assistant');
  console.log('3. Vapi will automatically configure the Twilio voice URL');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
