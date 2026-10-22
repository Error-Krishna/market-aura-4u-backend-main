const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');
const User = require('../src/models/User');
const completeOnboarding = require('../src/controllers/auth/onboarding');

const valid = () => ({
  companyName: 'Test brand', industry: 'Education', brandTone: 'Friendly',
  uvp: 'Practical lessons', targetAudience: 'Adult learners', platforms: ['twitter', 'instagram'],
});
let writes;
beforeEach(() => {
  writes = [];
  mock.method(User, 'findByIdAndUpdate', (...args) => {
    writes.push(args);
    return { select: async () => ({ _id: '111111111111111111111111', onboardingCompleted: true }) };
  });
});
afterEach(() => mock.restoreAll());

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const invalidBodies = [
  ['missing body', undefined], ['null body', null], ['array body', []], ['string body', 'brand'],
  ['empty body', {}], ['query operator value', { ...valid(), companyName: { $ne: null } }],
  ['client identity', { ...valid(), userId: '222222222222222222222222' }],
  ['privilege override', { ...valid(), isPremium: true }],
  ['completion override', { ...valid(), onboardingCompleted: true }],
  ['nested profile override', { ...valid(), brandProfile: { companyName: 'Override' } }],
  ['missing platforms', (() => { const body = valid(); delete body.platforms; return body; })()],
  ['empty platforms', { ...valid(), platforms: [] }],
  ['platform string', { ...valid(), platforms: 'twitter' }],
  ['unknown platform', { ...valid(), platforms: ['unknown'] }],
  ['platform casing', { ...valid(), platforms: ['Twitter'] }],
  ['duplicate platforms', { ...valid(), platforms: ['twitter', 'twitter'] }],
  ['object platform', { ...valid(), platforms: [{ $ne: null }] }],
];
for (const field of ['companyName', 'industry', 'brandTone', 'uvp', 'targetAudience']) {
  for (const [name, value] of [['missing', undefined], ['null', null], ['numeric', 12],
    ['array', ['text']], ['blank', '   '], ['oversized', 'a'.repeat(5001)]]) {
    invalidBodies.push([`${name} ${field}`, { ...valid(), [field]: value }]);
  }
}

for (const [name, body] of invalidBodies) {
  test(`onboarding rejects ${name} without writing or marking complete`, async () => {
    const res = response();
    await assert.doesNotReject(() => completeOnboarding({ user: { id: '111111111111111111111111' }, body }, res));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_ONBOARDING_INPUT');
    assert.deepEqual(writes, []);
  });
}

test('onboarding requires authentication before validation or persistence', async () => {
  const res = response();
  await assert.doesNotReject(() => completeOnboarding({ body: valid() }, res));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(writes, []);
});

test('validated fields and completion flag are one atomic owner-scoped partial update', async () => {
  const body = valid();
  for (const key of ['companyName', 'industry', 'brandTone', 'uvp', 'targetAudience']) body[key] = `  ${body[key]}  `;
  const res = response();
  await completeOnboarding({ user: { id: '111111111111111111111111' }, body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], [
    '111111111111111111111111',
    { $set: {
      onboardingCompleted: true,
      'brandProfile.companyName': 'Test brand', 'brandProfile.industry': 'Education',
      'brandProfile.uvp': 'Practical lessons', 'brandProfile.targetAudience': 'Adult learners',
      'brandProfile.brandVoice.tone': 'Friendly', 'brandProfile.platforms': ['twitter', 'instagram'],
    } },
    { new: true, runValidators: true },
  ]);
  assert.deepEqual(body.platforms, ['twitter', 'instagram']);
  assert.equal(body.companyName, '  Test brand  ', 'Validation must not mutate the request');
});

test('the maximum text length and all existing platforms remain supported', async () => {
  const res = response();
  const body = { ...valid(), uvp: 'a'.repeat(5000), platforms: ['twitter', 'linkedin', 'instagram', 'facebook', 'email', 'blog'] };
  await completeOnboarding({ user: { id: '111111111111111111111111' }, body }, res);
  assert.equal(res.statusCode, 200);
});

test('a deleted account returns 404 without claiming completion', async () => {
  mock.method(User, 'findByIdAndUpdate', () => ({ select: async () => null }));
  const res = response();
  await completeOnboarding({ user: { id: '111111111111111111111111' }, body: valid() }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
});

test('write failures never expose or log private database details', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  mock.method(User, 'findByIdAndUpdate', () => ({ select: async () => { throw new Error('test-only-private-data'); } }));
  const res = response();
  await completeOnboarding({ user: { id: '111111111111111111111111' }, body: valid() }, res);
  assert.equal(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.body).includes('test-only-private-data'));
  assert.ok(!logged.join(' ').includes('test-only-private-data'));
});
