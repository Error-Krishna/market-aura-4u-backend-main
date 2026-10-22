const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');
const User = require('../src/models/User');
const completeOnboarding = require('../src/controllers/auth/onboarding');
const getUserProfile = require('../src/controllers/auth/profile');

const marker = 'test-only-private-marker';
const id = '111111111111111111111111';
let user;
let projections;
let selectedIds;
beforeEach(() => {
  projections = []; selectedIds = [];
  user = {
    _id: id, name: 'Test user', email: 'test@example.invalid', onboardingCompleted: true,
    isPremium: true, password: marker, futureSecret: marker, createdAt: new Date('2026-01-01T00:00:00Z'),
    subscription: { paymentId: marker }, socialAccounts: { instagram: { accessToken: marker } },
    credits: { monthly: 100, used: 4, privateBillingData: marker },
    brandProfile: {
      companyName: 'Test brand', industry: 'Education', uvp: 'Practical lessons',
      targetAudience: 'Adult learners', marketingGoal: 'Awareness',
      brandVoice: { tone: 'Friendly', description: 'Clear guidance', futureSecret: marker },
      platforms: ['twitter'], futureSecret: marker,
    },
  };
  // Ignore the projection deliberately: serializers must stay safe even if an
  // adapter returns a full document or the schema gains a new private field.
  const query = value => ({ select: async fields => { projections.push(fields); return value; } });
  mock.method(User, 'findById', value => { selectedIds.push(value); return query(user); });
  mock.method(User, 'findByIdAndUpdate', value => { selectedIds.push(value); return query(user); });
});
afterEach(() => mock.restoreAll());
function response() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
}
const request = () => ({ user: { id }, body: {
  companyName: 'Test brand', industry: 'Education', brandTone: 'Friendly',
  uvp: 'Practical lessons', targetAudience: 'Adult learners', platforms: ['twitter'],
} });

test('onboarding returns only the nested user contract, never credentials or unknown fields', async () => {
  const res = response();
  await completeOnboarding(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.user).sort(), [
    'id', 'name', 'email', 'onboardingCompleted', 'isPremium', 'credits', 'brandProfile',
  ].sort());
  assert.deepEqual(res.body.user.brandProfile, {
    companyName: 'Test brand', industry: 'Education', uvp: 'Practical lessons',
    targetAudience: 'Adult learners', marketingGoal: 'Awareness',
    brandVoice: { tone: 'Friendly', description: 'Clear guidance' }, platforms: ['twitter'],
  });
  assert.deepEqual(res.body.user.credits, { monthly: 100, used: 4 });
  assert.equal(res.body.user.id, id);
  assert.ok(!JSON.stringify(res.body).includes(marker));
});

test('profile retains flat fields and includes UVP and both existing premium names', async () => {
  const res = response();
  await getUserProfile(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.id, id);
  assert.equal(res.body.data.isOnboarded, true);
  assert.equal(res.body.data.isPremium, true, 'AuthProvider reads this name');
  assert.equal(res.body.data.isUserPremium, true, 'Dashboard reads the legacy name');
  assert.equal(res.body.data.uvp, 'Practical lessons');
  assert.equal(res.body.data.joinedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(res.body.data.credits, { total: 100, used: 4, remaining: 96 });
  assert.deepEqual(res.body.data.brandVoice, { tone: 'Friendly', description: 'Clear guidance' });
  assert.ok(!JSON.stringify(res.body).includes(marker));
});

test('both endpoints use positive field projections and the authenticated account ID', async () => {
  await completeOnboarding(request(), response());
  const req = request();
  req.body = { userId: '222222222222222222222222' };
  await getUserProfile(req, response());
  assert.deepEqual(selectedIds, [id, id]);
  for (const fields of projections) {
    assert.ok(!fields.includes('-'), 'Use inclusion rather than password-only exclusion');
    assert.ok(!/password|socialAccounts|subscription|futureSecret/.test(fields));
    assert.ok(fields.includes('brandProfile.uvp'));
  }
});

test('profile handles missing optional data without returning nested unknown values', async () => {
  user = { _id: id, onboardingCompleted: false, credits: { monthly: NaN, used: -1 },
    brandProfile: { brandVoice: { tone: { secret: marker } }, platforms: ['twitter', { secret: marker }] } };
  const res = response();
  await getUserProfile(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.credits, { total: 100, used: 0, remaining: 100 });
  assert.deepEqual(res.body.data.brandVoice, { tone: 'Professional', description: '' });
  assert.deepEqual(res.body.data.platforms, ['twitter']);
  assert.ok(!JSON.stringify(res.body).includes(marker));
});

test('profile requires authentication even when invoked directly', async () => {
  const res = response();
  await getUserProfile({}, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(selectedIds, []);
});

test('profile returns 404 for a deleted account', async () => {
  user = null;
  const res = response();
  await getUserProfile(request(), res);
  assert.equal(res.statusCode, 404);
});

test('profile failures do not echo or log private database messages', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  mock.method(User, 'findById', () => ({ select: async () => { throw new Error(marker); } }));
  const res = response();
  await getUserProfile(request(), res);
  assert.equal(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.body).includes(marker));
  assert.ok(!logged.join(' ').includes(marker));
});
