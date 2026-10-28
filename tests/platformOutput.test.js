const assert = require('node:assert/strict');
const { test } = require('node:test');
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const { validateAndNormalizeContent, callAIAndGenerateContent, generateContent } = require('../src/controllers/content/generateContent');

const fixtures = {
  twitter: [{ text: 'A practical skincare tip. #skincare #routine' }],
  linkedin: ['A professional skincare announcement.'],
  facebook: ['A useful community skincare post.'],
  blog: ['Simple skincare: a concise draft with practical steps.'],
  instagram: { caption: 'A simple routine. Add hydration. Save this guide.' },
  email: { subject: 'Your simple routine', body: 'Start with a gentle cleanser.' },
};
const clone = value => structuredClone(value);
const brand = { brandProfile: {
  companyName: 'Offline fixture', industry: 'beauty', uvp: 'Simple care.',
  targetAudience: 'Adults.', platforms: Object.keys(fixtures),
} };

for (const platform of Object.keys(fixtures)) {
  test(`${platform}: accepts its documented output shape and rejects missing content`, () => {
    const output = validateAndNormalizeContent({ [platform]: clone(fixtures[platform]) }, [platform], false);
    assert.deepEqual(output[platform], platform === 'instagram'
      ? { ...fixtures.instagram, content_type: 'image' } : fixtures[platform]);
    assert.throws(() => validateAndNormalizeContent({}, [platform], false), /LLM output/);
    assert.throws(() => validateAndNormalizeContent({ [platform]: null }, [platform], false), /LLM output/);
  });
}

for (const platform of ['facebook', 'blog']) {
  test(`${platform}: rejects empty, wrong-type, blank and mixed-invalid arrays`, () => {
    for (const value of [[], '', 'A post', {}, [' '], [42], [null], ['Valid', {}], ['Valid', '']]) {
      assert.throws(() => validateAndNormalizeContent({ [platform]: value }, [platform], false), /LLM output/);
    }
  });
}

for (const [label, value, expected] of [
  ['single string', 'A LinkedIn post.', ['A LinkedIn post.']],
  ['single text object', { text: 'A LinkedIn post.' }, ['A LinkedIn post.']],
  ['string array', ['First post.', 'Second post.'], ['First post.', 'Second post.']],
  ['text objects', [{ text: 'First post.' }, { text: 'Second post.' }], ['First post.', 'Second post.']],
  ['mixed text entries', ['First post.', { text: 'Second post.' }], ['First post.', 'Second post.']],
]) {
  test(`LinkedIn normalizes ${label} without changing its text or public array contract`, () => {
    const output = validateAndNormalizeContent({ linkedin: clone(value) }, ['linkedin'], false);
    assert.deepEqual(output, { linkedin: expected });
  });
}

test('LinkedIn rejects missing, empty, ambiguous and malformed text without invented content', () => {
  for (const value of [null, undefined, 42, true, [], '', ' ', {}, [' '], [42], [null], ['Valid', {}],
    ['Valid', ''], { text: ' ' }, { text: 42 }, { body: 'Not an approved text shape' },
    { text: 'Title', body: 'Additional content must not be discarded' },
    { text: { nested: 'Do not stringify' } }, [{ text: 'Valid' }, { text: null }]]) {
    assert.throws(() => validateAndNormalizeContent({ linkedin: value }, ['linkedin'], false), error => {
      assert.equal(error.name, 'GenerationValidationError');
      return true;
    });
  }
  assert.throws(() => validateAndNormalizeContent({}, ['linkedin'], false), /missing required/);
  assert.throws(() => validateAndNormalizeContent({ linkedin: Object.create({ text: 'Inherited' }) }, ['linkedin'], false));
});

test('Twitter rejects invented-fallback cases, malformed entries and overlong text', () => {
  for (const value of [[], 'A tweet', {}, [null], ['A tweet'], [{}], [{ text: ' ' }],
    [{ text: 123 }], [{ text: 'a'.repeat(281) }], [{ text: 'Valid' }, {}]]) {
    assert.throws(() => validateAndNormalizeContent({ twitter: value }, ['twitter'], false), /LLM output/);
  }
  assert.equal(validateAndNormalizeContent({ twitter: [{ text: '😀'.repeat(280) }] }, ['twitter'], false).twitter.length, 1);
});

test('Email requires a subject and body with actual text', () => {
  for (const value of [[], {}, { subject: 'Title' }, { body: 'Body' },
    { subject: ' ', body: 'Body' }, { subject: 'Title', body: {} }]) {
    assert.throws(() => validateAndNormalizeContent({ email: value }, ['email'], false), /LLM output/);
  }
});

test('every selected platform is required and unrequested provider keys are discarded', () => {
  assert.throws(() => validateAndNormalizeContent({ facebook: fixtures.facebook }, ['facebook', 'blog'], false), /blog/);
  assert.deepEqual(validateAndNormalizeContent({ facebook: fixtures.facebook, blog: fixtures.blog,
    grounding: { isGrounded: true }, imageUrl: 'provider-url', futureField: 'discard' }, ['facebook'], false),
  { facebook: fixtures.facebook });
  const inherited = Object.create({ facebook: fixtures.facebook });
  assert.throws(() => validateAndNormalizeContent(inherited, ['facebook'], false), /facebook/);
});

test('carousel normalizes real slides, preserves legacy strings and caps at seven', () => {
  const slides = Array.from({ length: 8 }, () => ({ slide_number: 99, headline: 'Useful step', body: 'A practical action.' }));
  const output = validateAndNormalizeContent({ instagram: { caption: 'Swipe for steps.', slides } }, ['instagram'], true);
  assert.equal(output.instagram.slides.length, 7);
  assert.deepEqual(output.instagram.slides.map(slide => slide.slide_number), [1, 2, 3, 4, 5, 6, 7]);
  const legacy = validateAndNormalizeContent({ instagram: { caption: 'Swipe.', slides: ['Cleanse', 'Hydrate', 'Protect'] } }, ['instagram'], true);
  assert.equal(legacy.instagram.slides[2].body, 'Protect');
});

test('carousel rejects partial, null, empty and malformed supplied slides without invented content', () => {
  for (const slides of [null, {}, [], ['One'], ['One', 'Two'], [null, null, null], ['', 'Two', 'Three'],
    [{ headline: 'Title', body: {} }, 'Two', 'Three'], [{ headline: ' ', body: 'Body' }, 'Two', 'Three'],
    [{ headline: 'Title' }, 'Two', 'Three']]) {
    assert.throws(() => validateAndNormalizeContent({ instagram: { caption: 'Swipe.', slides } }, ['instagram'], true), /LLM output/);
  }
});

test('offline provider prompt covers all selected platforms with one bounded completion', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.equal(body.n, 1);
      assert.equal(body.max_completion_tokens, 1536);
      const system = body.messages.find(message => message.role === 'system').content;
      for (const platform of Object.keys(fixtures)) assert.ok(system.includes(`"${platform}":`));
      assert.ok(system.includes('LinkedIn must be a non-empty array of plain text strings, not an object.'));
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fixtures) } }] }) };
    };
    const output = await callAIAndGenerateContent('Create a useful skincare post', brand, Object.keys(fixtures));
    for (const platform of Object.keys(fixtures)) assert.ok(output[platform]);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('a truncated provider response fails even if its partial JSON is parseable, without retries', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(fixtures) } }] }) };
    };
    await assert.rejects(callAIAndGenerateContent('Create a useful skincare post', brand, ['blog']), /completion token limit/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

for (const complete of [false, true]) {
  test(`controller ${complete ? 'completes valid' : 'fails incomplete'} Facebook/Blog output with mocked providers and persistence`, async () => {
    const original = { fetch: globalThis.fetch, find: User.findById, save: Job.prototype.save, update: Job.findByIdAndUpdate };
    const updates = [];
    let providerCalls = 0;
    try {
      User.findById = async () => ({ ...brand, brandProfile: { ...brand.brandProfile, platforms: ['facebook', 'blog'] } });
      Job.prototype.save = async function () { return this; };
      Job.findByIdAndUpdate = async (id, update) => { updates.push(update); return { id, ...update }; };
      globalThis.fetch = async (url) => {
        if (url.includes('/recommend')) return { ok: true, json: async () => ({ recommended_topic: 'skincare' }) };
        assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
        providerCalls++;
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(
          complete ? { facebook: fixtures.facebook, blog: fixtures.blog } : { facebook: fixtures.facebook },
        ) } }] }) };
      };
      let status, response;
      const res = { status(value) { status = value; return this; }, json(value) { response = value; return this; } };
      await generateContent({ user: { id: complete ? '507f1f77bcf86cd799439011' : '507f1f77bcf86cd799439012' }, body: { prompt: 'Create a useful skincare post' } }, res);
      assert.equal(status, complete ? 200 : 500);
      assert.equal(response.success, complete);
      assert.equal(providerCalls, 1);
      assert.deepEqual(updates.map(update => update.status), [complete ? 'completed' : 'failed']);
      if (complete) {
        assert.deepEqual(response.job.generatedContent.blog, fixtures.blog);
        assert.deepEqual(response.job.generatedContent.facebook, fixtures.facebook);
      } else {
        assert.equal(response.code, 'GENERATION_FAILED');
        assert.equal(response.error, 'Generation failed');
        assert.equal(updates[0].error, 'Generation failed');
        assert.equal(updates[0].generatedContent, undefined);
      }
    } finally {
      globalThis.fetch = original.fetch; User.findById = original.find;
      Job.prototype.save = original.save; Job.findByIdAndUpdate = original.update;
    }
  });
}
