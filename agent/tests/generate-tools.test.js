'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildToolsDocument } = require('../scripts/generate-tools');

/**
 * agent/tools.json is a generated, human-readable view of the tool contract.
 *
 * Other lanes were told tools.json is the interface they build against, so it
 * stays at its original path — but it is derived from the use case's TOOLS
 * definition rather than hand-maintained, so it cannot drift into fiction.
 */

const TOOLS_JSON = path.join(__dirname, '..', 'tools.json');

describe('buildToolsDocument', () => {
  test('includes the use case name and prompt version', () => {
    const doc = buildToolsDocument();
    assert.strictEqual(doc.use_case, 'medication-adherence');
    assert.ok(doc.prompt_version >= 2);
  });

  test('carries every tool from the strategy', () => {
    const doc = buildToolsDocument();
    const {
      TOOLS,
    } = require('../src/use-cases/medication-adherence/tools');
    assert.strictEqual(doc.tools.length, TOOLS.length);
    assert.deepStrictEqual(
      doc.tools.map((t) => t.function.name),
      TOOLS.map((t) => t.function.name)
    );
  });

  test('marks itself generated so nobody hand-edits it', () => {
    const doc = buildToolsDocument();
    assert.ok(doc._generated, 'document should declare it is generated');
    assert.match(doc._generated, /generate-tools/);
  });

  test('is deterministic — same input, same bytes', () => {
    const a = JSON.stringify(buildToolsDocument());
    const b = JSON.stringify(buildToolsDocument());
    assert.strictEqual(a, b);
  });
});

describe('committed tools.json is not stale', () => {
  test('tools.json exists', () => {
    assert.ok(fs.existsSync(TOOLS_JSON), 'agent/tools.json should exist');
  });

  test('tools.json matches what the generator would write', () => {
    const onDisk = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
    assert.deepStrictEqual(
      onDisk,
      buildToolsDocument(),
      'agent/tools.json is stale — run `npm run generate-tools`'
    );
  });
});
