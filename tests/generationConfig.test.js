const assert = require('node:assert/strict');
const { test } = require('node:test');
const readGenerationConfig = require('../src/config/generation');

test('Groq output token limit defaults to a bounded value and accepts a valid override', () => {
  assert.equal(readGenerationConfig({}).groqMaxOutputTokens, 1536);
  assert.equal(readGenerationConfig({ GROQ_MAX_OUTPUT_TOKENS: '256' }).groqMaxOutputTokens, 256);
  assert.equal(readGenerationConfig({ GROQ_MAX_OUTPUT_TOKENS: '1536' }).groqMaxOutputTokens, 1536);
  assert.equal(readGenerationConfig({ GROQ_MAX_OUTPUT_TOKENS: '4096' }).groqMaxOutputTokens, 4096);
});

test('Groq output token limit rejects zero, non-integers, and values above its bound', () => {
  for (const value of ['0', '1.5', '4097', 'unlimited']) {
    assert.throws(
      () => readGenerationConfig({ GROQ_MAX_OUTPUT_TOKENS: value }),
      /GROQ_MAX_OUTPUT_TOKENS must be an integer/,
    );
  }
});
