'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SqliteRepository = require('../src/adapters/persistence/sqlite');
const ConsoleRepository = require('../src/adapters/persistence/console');
const { parseArgs, _status } = require('../scripts/ground-truth');

/**
 * Task 3 — recording what actually happened on a call.
 *
 * calls.ground_truth existed but nothing populated it. setGroundTruth()
 * fails loudly on an unknown call id (an UPDATE matching zero rows must
 * never look like a successful write — the same rule as endSession() and
 * setDoseStatus()), and scripts/ground-truth.js is the human-facing CLI
 * for setting it and listing which calls' derived outcome disagrees.
 */

const tmpDbs = [];

function freshRepo() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sahay-ground-truth-')),
    'test.db'
  );
  tmpDbs.push(dbPath);
  return new SqliteRepository({ dbPath });
}

after(() => {
  for (const p of tmpDbs) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe('SqliteRepository.setGroundTruth', () => {
  test('sets and reads back ground truth', async () => {
    const repo = freshRepo();
    await repo.createCall({ callId: 'gt-1' });
    await repo.save({ callId: 'gt-1', label: 'CONFIRMED' });

    const updated = await repo.setGroundTruth('gt-1', 'CONFIRMED');
    assert.strictEqual(updated.ground_truth, 'CONFIRMED');

    const call = await repo.getCall('gt-1');
    assert.strictEqual(call.ground_truth, 'CONFIRMED');
  });

  test('rejects loudly on an unknown call id, rather than silently matching zero rows', async () => {
    const repo = freshRepo();
    await assert.rejects(
      repo.setGroundTruth('does-not-exist', 'CONFIRMED'),
      /Unknown call/
    );
  });
});

describe('ConsoleRepository.setGroundTruth', () => {
  test('does not throw — a persistence swap must not crash on a missing method', async () => {
    const repo = new ConsoleRepository();
    await assert.doesNotReject(repo.setGroundTruth('any-call', 'CONFIRMED'));
  });
});

describe('ground-truth script', () => {
  test('_status distinguishes unlabelled, agreeing, and disagreeing calls', () => {
    assert.strictEqual(_status({ outcome_label: 'CONFIRMED', ground_truth: null }), 'UNLABELLED');
    assert.strictEqual(_status({ outcome_label: 'CONFIRMED', ground_truth: 'CONFIRMED' }), 'AGREE');
    assert.strictEqual(_status({ outcome_label: 'CONFIRMED', ground_truth: 'DENIED' }), 'DISAGREE');
    assert.strictEqual(_status({ outcome_label: null, ground_truth: 'DENIED' }), 'NO_DERIVED_OUTCOME');
  });

  test('parseArgs splits flags from positional args', () => {
    const { flags, positional } = parseArgs(['set', 'call-1', '--limit=5', 'CONFIRMED']);
    assert.deepStrictEqual(positional, ['set', 'call-1', 'CONFIRMED']);
    assert.strictEqual(flags.limit, '5');
  });
});
