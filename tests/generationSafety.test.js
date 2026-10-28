const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, after, mock } = require('node:test');
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const testEnv = {
  GENERATION_MAX_REQUESTS: '10', GENERATION_WINDOW_MS: '60000',
  GENERATION_MAX_CONCURRENT: '1', GENERATION_MAX_USERS: '100', GROQ_TIMEOUT_MS: '45000',
  GROQ_API_KEY: 'test-only-generation-key',
};
const originalEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, testEnv);
const { generateContent } = require('../src/controllers/content/generateContent');
after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let user;
let calls;
let sequence = 0;

beforeEach(() => {
  calls = [];
  user = {
    id: `test-user-${++sequence}`,
    brandProfile: {
      companyName: 'Test brand', industry: 'Education', uvp: 'Practical lessons',
      targetAudience: 'Adult learners', platforms: ['twitter'],
      brandVoice: { tone: 'Friendly', description: 'Clear and helpful' },
    },
  };
  mock.method(User, 'findById', async () => { calls.push('user'); return user; });
  mock.method(Job.prototype, 'save', async function () { calls.push('save'); return this; });
  mock.method(Job, 'findByIdAndUpdate', async (_id, update) => {
    calls.push(update.status);
    return { _id, ...update };
  });
  mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('recommend')) {
      calls.push('recommender');
      return { ok: true, json: async () => ({ recommended_topic: 'Learning' }) };
    }
    assert.ok(url.includes('groq.com'), 'Unexpected provider');
    calls.push('groq');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: {
        content: JSON.stringify({ twitter: [{ text: 'Build a new skill today.' }] }),
      } }] }),
    };
  });
});
afterEach(() => mock.restoreAll());

function http(body = { prompt: 'Learn a new skill today' }, identity = user.id) {
  return {
    req: { body, user: identity ? { id: identity } : null },
    res: {
      statusCode: 200, headers: {}, body: null,
      status(value) { this.statusCode = value; return this; },
      set(name, value) { this.headers[name] = value; return this; },
      json(value) { this.body = value; return this; },
    },
  };
}

for (const [name, body] of [
  ['null body', null], ['array body', []], ['string body', 'hello'],
  ['missing prompt', {}], ['null prompt', { prompt: null }],
  ['numeric prompt', { prompt: 12345 }], ['boolean prompt', { prompt: true }],
  ['object prompt', { prompt: {} }], ['array prompt', { prompt: ['hello'] }],
  ['blank prompt', { prompt: '      ' }], ['short prompt', { prompt: 'abcd' }],
  ['oversized prompt', { prompt: 'a'.repeat(5001) }],
  ['oversized padded prompt', { prompt: ' '.repeat(5000) + 'hello' }],
  ['client supplied identity', { prompt: 'hello world', userId: 'another-user' }],
  ['client supplied platforms', { prompt: 'hello world', platforms: ['twitter'] }],
]) {
  test(`rejects ${name} before database or provider work`, async () => {
    const { req, res } = http(body);
    await generateContent(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_GENERATION_INPUT');
    assert.deepEqual(calls, []);
  });
}

test('missing body is a validation error', async () => {
  const { req, res } = http();
  delete req.body;
  await generateContent(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});

test('authentication is required before validation', async () => {
  const { req, res } = http(null, null);
  await generateContent(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls, []);
});

for (const [name, change] of [
  ['non-string company name', (bp) => { bp.companyName = {}; }],
  ['oversized business description', (bp) => { bp.uvp = 'a'.repeat(5001); }],
  ['invalid target audience', (bp) => { bp.targetAudience = []; }],
  ['invalid tone', (bp) => { bp.brandVoice.tone = 123; }],
  ['oversized voice rules', (bp) => { bp.brandVoice.description = 'a'.repeat(5001); }],
  ['non-array platforms', (bp) => { bp.platforms = 'twitter'; }],
  ['unknown platform', (bp) => { bp.platforms = ['unrecognized']; }],
  ['duplicate platforms', (bp) => { bp.platforms = ['twitter', 'twitter']; }],
]) {
  test(`rejects ${name} in saved brand context before provider calls`, async () => {
    change(user.brandProfile);
    const { req, res } = http();
    await generateContent(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_BRAND_PROFILE');
    assert.deepEqual(calls, ['user']);
  });
}

for (const prompt of ['hello', 'a'.repeat(5000), '  Learn something new\nwith a friend 🌱  ']) {
  test(`accepts and trims a valid prompt (${prompt.length} code units)`, async () => {
    let savedPrompt;
    mock.method(Job.prototype, 'save', async function () {
      savedPrompt = this.originalContent;
      return this;
    });
    const { req, res } = http({ prompt });
    await generateContent(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(savedPrompt, prompt.trim());
    assert.ok(calls.includes('recommender'));
    assert.ok(calls.includes('groq'));
  });
}

test('excess requests for the same authenticated user stop before providers or job writes', async () => {
  for (let i = 0; i < 10; i++) {
    const { req, res } = http();
    await generateContent(req, res);
    assert.equal(res.statusCode, 200);
  }
  calls = [];
  const { req, res } = http();
  await generateContent(req, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'GENERATION_RATE_LIMIT');
  assert.ok(Number(res.headers['Retry-After']) > 0);
  assert.deepEqual(calls, ['user']);
});

test('legacy audience context remains accepted without optional voice settings', async () => {
  user.brandProfile.targetAudience = { description: 'Adult learners', painPoint: 'Limited time', desire: 'Useful skills' };
  delete user.brandProfile.brandVoice;
  const { req, res } = http();
  await generateContent(req, res);
  assert.equal(res.statusCode, 200);
});

for (const platforms of [undefined, []]) {
  test(`preserves default platforms when the stored list is ${platforms ? 'empty' : 'absent'}`, async () => {
    user.brandProfile.platforms = platforms;
    const provider = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (url, options) => {
      if (url.includes('recommend')) return provider(url, options);
      return { ok: true, json: async () => ({ choices: [{ message: {
        content: JSON.stringify({ twitter: [{ text: 'Learn today.' }], instagram: { caption: 'Learn today.' } }),
      } }] }) };
    });
    let savedPlatforms;
    mock.method(Job.prototype, 'save', async function () { savedPlatforms = [...this.platforms]; return this; });
    const { req, res } = http();
    await generateContent(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(savedPlatforms, ['instagram', 'twitter']);
  });
}

test('overlapping requests are rejected for the same user while another user can generate', async () => {
  let unblock;
  let entered;
  const gate = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const provider = globalThis.fetch;
  let providerStarts = 0;
  mock.method(globalThis, 'fetch', async (...args) => {
    if (++providerStarts === 1) { entered(); await gate; }
    return provider(...args);
  });
  const first = http();
  const firstRun = generateContent(first.req, first.res);
  await started;
  const second = http();
  const other = http({ prompt: 'Learn another skill' }, 'different-authenticated-user');
  try {
    await generateContent(second.req, second.res);
    await generateContent(other.req, other.res);
  } finally {
    unblock();
    await firstRun;
  }
  assert.equal(first.res.statusCode, 200);
  assert.equal(second.res.statusCode, 429);
  assert.equal(second.res.body.code, 'GENERATION_IN_PROGRESS');
  assert.equal(other.res.statusCode, 200);
  assert.equal(providerStarts, 4, 'Exactly two admitted requests may call both providers');
  const retry = http();
  await generateContent(retry.req, retry.res);
  assert.equal(retry.res.statusCode, 200, 'Slot is released after successful completion');
});

test('provider failures still consume request quota and release their active slot', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('Simulated provider failure'); });
  for (let i = 0; i < 10; i++) {
    const { req, res } = http();
    await generateContent(req, res);
    assert.equal(res.statusCode, 500);
  }
  calls = [];
  const { req, res } = http();
  await generateContent(req, res);
  assert.equal(res.body.code, 'GENERATION_RATE_LIMIT');
  assert.deepEqual(calls, ['user']);
});

test('a failed job-status write cannot prevent an error response or leak a slot', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('Simulated provider failure'); });
  mock.method(Job, 'findByIdAndUpdate', async () => { throw new Error('Simulated DB failure'); });
  for (let i = 0; i < 2; i++) {
    const { req, res } = http();
    await assert.doesNotReject(() => generateContent(req, res));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
  }
});

test('job creation failure releases the slot without calling Groq', async () => {
  mock.method(Job.prototype, 'save', async () => { throw new Error('Simulated DB failure'); });
  for (let i = 0; i < 2; i++) {
    const { req, res } = http();
    await generateContent(req, res);
    assert.equal(res.statusCode, 500);
  }
  assert.equal(calls.filter(call => call === 'recommender').length, 2);
  assert.ok(!calls.includes('groq'));
});
