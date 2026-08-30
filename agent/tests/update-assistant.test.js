'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { main } = require('../scripts/update-assistant');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'assistant.json');

// Fake Vapi client that records whether a PATCH was attempted. Tests must
// never let a real PATCH happen — this stands in for scripts/lib/vapi-client
// and the assertions below confirm it's the only thing that can "update"
// the live assistant during the test run.
function makeFakeVapiClient() {
  const calls = [];
  return {
    calls,
    async updateAssistant(assistantId, config) {
      calls.push({ assistantId, config });
      return { id: assistantId, updatedAt: 'fake' };
    },
  };
}

describe('scripts/update-assistant.js', () => {
  let originalAssistantId;
  let originalConfigContents;

  beforeEach(() => {
    originalAssistantId = process.env.VAPI_ASSISTANT_ID;
    process.env.VAPI_ASSISTANT_ID = 'test-assistant-id';
    originalConfigContents = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (originalAssistantId === undefined) {
      delete process.env.VAPI_ASSISTANT_ID;
    } else {
      process.env.VAPI_ASSISTANT_ID = originalAssistantId;
    }
    // Restore the committed config exactly — a --yes test run overwrites it.
    if (originalConfigContents !== null) {
      fs.writeFileSync(CONFIG_PATH, originalConfigContents);
    }
  });

  test('defaults to a dry run: never calls updateAssistant, never writes config/assistant.json', async () => {
    const vapiClient = makeFakeVapiClient();

    const result = await main([], { vapiClient });

    assert.strictEqual(result.applied, false);
    assert.strictEqual(vapiClient.calls.length, 0, 'dry run must not PATCH Vapi');
    assert.strictEqual(
      fs.readFileSync(CONFIG_PATH, 'utf8'),
      originalConfigContents,
      'dry run must not overwrite the committed config'
    );
  });

  test('--yes applies the update: calls updateAssistant exactly once', async () => {
    const vapiClient = makeFakeVapiClient();

    const result = await main(['--yes'], { vapiClient });

    assert.strictEqual(result.applied, true);
    assert.strictEqual(vapiClient.calls.length, 1);
    assert.strictEqual(vapiClient.calls[0].assistantId, 'test-assistant-id');
  });

  test('--confirm is accepted as an alias for --yes', async () => {
    const vapiClient = makeFakeVapiClient();

    const result = await main(['--confirm'], { vapiClient });

    assert.strictEqual(result.applied, true);
    assert.strictEqual(vapiClient.calls.length, 1);
  });
});
