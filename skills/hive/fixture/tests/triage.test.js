import { test } from 'node:test';
import assert from 'node:assert';
import { assess } from '../src/triage.js';

test('escalates on chest pain', async () => {
  const ctx = {};
  const r = await assess('I have chest pain', ctx);
  assert.equal(r.acuity, 1);
  assert.equal(ctx.escalated, true);
});
