'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SentenceBuffer } = require('../src/utils/sentence-buffer');

describe('SentenceBuffer', () => {
  it('emits complete sentences on punctuation', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('Hello world. This is a test!');
    sb.flush();

    assert.deepEqual(sentences, ['Hello world.', 'This is a test!']);
  });

  it('handles multiple sentences in one push', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('First. Second! Third?');
    sb.flush();

    assert.deepEqual(sentences, ['First.', 'Second!', 'Third?']);
  });

  it('buffers incomplete sentences until flush', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('This is incomplete');
    assert.equal(sentences.length, 0);

    sb.flush();
    assert.equal(sentences.length, 1);
    assert.equal(sentences[0], 'This is incomplete');
  });

  it('handles Devanagari danda (।) as sentence ender', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('नमस्ते। आप कैसे हैं?');
    sb.flush();

    assert.deepEqual(sentences, ['नमस्ते।', 'आप कैसे हैं?']);
  });

  it('handles token-by-token streaming', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    const tokens = ['Hello', ' world', '. ', 'Next', ' sentence', '!'];
    for (const t of tokens) sb.push(t);
    sb.flush();

    assert.deepEqual(sentences, ['Hello world.', 'Next sentence!']);
  });

  it('reset clears the buffer', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('Incomplete sentence');
    sb.reset();
    sb.flush();

    assert.equal(sentences.length, 0);
  });

  it('getPending returns buffered text', () => {
    const sb = new SentenceBuffer();
    sb.push('Partial text');

    assert.equal(sb.getPending(), 'Partial text');
  });

  it('trims whitespace from sentences', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('  Hello world.  ');
    sb.flush();

    assert.equal(sentences[0], 'Hello world.');
  });

  it('does not emit empty sentences', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('. . .');
    sb.flush();

    // Each ". " produces a sentence, but the trimmed content is just "."
    // which is non-empty, so they should all emit
    sentences.forEach((s) => assert.ok(s.length > 0));
  });

  it('handles mixed Latin and Devanagari text', () => {
    const sb = new SentenceBuffer();
    const sentences = [];
    sb.onSentence((s) => sentences.push(s));

    sb.push('Hello। नमस्ते। Bye!');
    sb.flush();

    assert.ok(sentences.length >= 2);
  });
});
