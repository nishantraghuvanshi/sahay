'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const MedicationAdherenceStrategy = require('../src/use-cases/medication-adherence/strategy');

const CONFIG_DIR = path.join(__dirname, '..', 'config', 'use-cases');
const load = (f) => yaml.load(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));

describe('a language config must not silently fall behind', () => {
  // On 30 August the English config sat at version 6 while Hindi reached 16.
  // Every fix that day — the output contract that stops the model narrating its
  // reasoning aloud, atomic escalation, the reminder that makes it a reminder
  // call, the rule against reading "maybe" as taken — landed only in Hindi.
  // An English call would have reproduced each of them.
  //
  // Nothing caught it. The test named "ported guardrails exist in both
  // languages" was green throughout, because it regex-matches guardrail LABELS
  // and a label is not a behaviour. Ten versions of divergence sat underneath a
  // passing test.
  //
  // Porting English properly is a day's work for a language the product does
  // not serve yet. Until someone does it, the drift must at least be loud.

  test('the English config is behind, and says so rather than pretending', () => {
    const hi = load('medication-adherence.yaml');
    const en = load('medication-adherence-en.yaml');
    if (en.version >= hi.version) return; // ported: nothing to warn about
    // The file must carry the warning at the top, where anyone about to use it
    // will see it before they use it.
    const raw = fs.readFileSync(path.join(CONFIG_DIR, 'medication-adherence-en.yaml'), 'utf8');
    assert.match(raw.slice(0, 2000), /STALE|DO NOT SHIP/i,
      'a config behind the Hindi one must carry a visible warning');
  });

  test('loading the stale language refuses, instead of serving old guardrails', () => {
    const hi = load('medication-adherence.yaml');
    const en = load('medication-adherence-en.yaml');
    if (en.version >= hi.version) {
      // Once ported, it must actually load.
      assert.doesNotThrow(() => new MedicationAdherenceStrategy('en'));
      return;
    }
    assert.throws(
      () => new MedicationAdherenceStrategy('en'),
      (err) => {
        // The message has to name both versions, or whoever hits it has to go
        // digging to learn what "stale" means.
        assert.match(err.message, new RegExp(String(en.version)));
        assert.match(err.message, new RegExp(String(hi.version)));
        return true;
      }
    );
  });

  test('Hindi, the language actually served, always loads', () => {
    assert.doesNotThrow(() => new MedicationAdherenceStrategy('hi'));
    assert.doesNotThrow(() => new MedicationAdherenceStrategy());
  });
});
