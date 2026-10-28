const assert = require('node:assert/strict');
const http = require('node:http');
const { before, beforeEach, after, test, mock } = require('node:test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { validBrandProfile } = require('../src/utils/generationInput');

const testEnv = { NODE_ENV: 'test', CORS_ALLOWED_ORIGINS: 'https://app.example', JWT_SECREAT_KEY: 'test-only-onboarding-key' };
const originalEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
const ids = ['111111111111111111111111', '222222222222222222222222'];
const marker = 'test-only-private-marker';
let server;
let accounts;
let writes;
let reads;
let writeError;
let missingUpdate;

before(async () => {
  Object.assign(process.env, testEnv);
  mock.method(mongoose, 'connect', () => assert.fail('No database connection allowed'));
  mock.method(globalThis, 'fetch', () => assert.fail('No provider calls allowed'));
  mock.method(User, 'findOne', async ({ email }) => {
    reads++;
    return [...accounts.values()].find(user => user.email === email);
  });
  mock.method(User, 'findById', id => ({ select: async () => {
    reads++;
    return structuredClone(accounts.get(String(id)));
  } }));
  mock.method(User, 'findByIdAndUpdate', (id, update, options) => ({ select: async () => {
    writes.push({ id, update: structuredClone(update), options });
    if (writeError) throw writeError;
    if (missingUpdate) return null;
    const updated = structuredClone(accounts.get(String(id)));
    for (const [path, value] of Object.entries(update.$set)) {
      const parts = path.split('.');
      let parent = updated;
      for (const part of parts.slice(0, -1)) parent = parent[part] ??= {};
      parent[parts.at(-1)] = value;
    }
    accounts.set(String(id), updated);
    // Deliberately return credentials too, independent of query projection.
    return structuredClone(updated);
  } }));
  server = http.createServer(require('../src/app'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});
beforeEach(() => {
  writes = []; reads = 0; writeError = null; missingUpdate = false;
  accounts = new Map(ids.map((id, index) => [id, {
    _id: id, id, name: `User ${index}`, email: `user${index}@example.invalid`,
    password: marker, onboardingCompleted: false, isPremium: false,
    credits: { monthly: 100, used: 4 }, subscription: { paymentId: marker },
    socialAccounts: { instagram: { accessToken: marker } }, futureSecret: marker,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    brandProfile: { companyName: 'Old brand', marketingGoal: 'Existing goal',
      brandVoice: { tone: 'Professional', description: 'Existing voice rules', secret: marker },
    },
  } ]));
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  mock.restoreAll();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const validBody = () => ({ companyName: '  New brand  ', industry: ' Education ',
  brandTone: ' Friendly ', uvp: ' Practical lessons ', targetAudience: ' Adult learners ',
  platforms: ['twitter', 'instagram'],
});
function request({ method = 'POST', path = '/api/v1/auth/onboarding', body = validBody(), raw,
  account = 0, authenticated = true, cookie = false } = {}) {
  const text = method === 'GET' ? undefined : raw === undefined ? JSON.stringify(body) : raw;
  const token = jwt.sign({ email: accounts.get(ids[account]).email, id: ids[1 - account] }, testEnv.JWT_SECREAT_KEY);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path,
      headers: {
        Origin: 'https://app.example',
        ...(text === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }),
        ...(authenticated ? cookie ? { Cookie: `token=${token}` } : { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode,
          body: res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local request timed out')));
    req.end(text);
  });
}

test('onboarding and profile routes require authentication before account access', async () => {
  assert.equal((await request({ authenticated: false })).status, 401);
  assert.equal((await request({ authenticated: false, method: 'GET', path: '/api/v1/auth/profile' })).status, 401);
  assert.equal(reads, 0);
  assert.deepEqual(writes, []);
});

test('incomplete input and account overrides cannot write or mark a profile complete', async () => {
  const before = structuredClone([...accounts]);
  for (const body of [{}, { ...validBody(), uvp: '' }, { ...validBody(), platforms: [] },
    { ...validBody(), userId: ids[1] }, { ...validBody(), credits: { monthly: 99999 } }]) {
    const response = await request({ body });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_ONBOARDING_INPUT');
  }
  assert.deepEqual(writes, []);
  assert.deepEqual([...accounts], before);
});

test('completion round-trips safe brand data and preserves settings, credentials and another account', async () => {
  const otherBefore = structuredClone(accounts.get(ids[1]));
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.user.id, ids[0], 'Use the database identity, not another JWT claim ID');
  assert.equal(response.body.user.onboardingCompleted, true);
  assert.ok(!JSON.stringify(response.body).includes(marker));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, ids[0]);
  assert.equal(writes[0].options.runValidators, true);
  const saved = accounts.get(ids[0]);
  assert.equal(saved.onboardingCompleted, true);
  assert.equal(saved.brandProfile.companyName, 'New brand');
  assert.equal(saved.brandProfile.marketingGoal, 'Existing goal');
  assert.equal(saved.brandProfile.brandVoice.description, 'Existing voice rules');
  assert.equal(saved.password, marker);
  assert.equal(saved.socialAccounts.instagram.accessToken, marker);
  assert.equal(saved.subscription.paymentId, marker);
  assert.deepEqual(saved.credits, { monthly: 100, used: 4 });
  assert.equal(validBrandProfile(saved.brandProfile), true, 'Persisted context must be accepted by generation');
  assert.deepEqual(accounts.get(ids[1]), otherBefore);
  const profile = await request({ method: 'GET', path: '/api/v1/auth/profile', cookie: true });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.isOnboarded, true);
  assert.equal(profile.body.data.uvp, 'Practical lessons');
  assert.equal(profile.body.data.companyName, 'New brand');
  assert.deepEqual(profile.body.data.platforms, ['twitter', 'instagram']);
  assert.equal(profile.body.data.brandVoice.description, 'Existing voice rules');
  assert.ok(!JSON.stringify(profile.body).includes(marker));
});

test('invalid resubmission leaves an already completed profile unchanged', async () => {
  assert.equal((await request()).status, 200);
  const before = structuredClone(accounts.get(ids[0]));
  const response = await request({ body: { ...validBody(), companyName: '   ' } });
  assert.equal(response.status, 400);
  assert.equal(writes.length, 1);
  assert.deepEqual(accounts.get(ids[0]), before);
});

test('write rejection cannot claim or persist completion and does not expose database details', async () => {
  const before = structuredClone(accounts.get(ids[0]));
  writeError = new Error(marker);
  const response = await request();
  assert.equal(response.status, 500);
  assert.equal(response.body.success, false);
  assert.ok(!JSON.stringify(response.body).includes(marker));
  assert.deepEqual(accounts.get(ids[0]), before);
});

test('schema validation failures return 400 and a deleted account returns 404', async () => {
  writeError = Object.assign(new Error(marker), { name: 'ValidationError' });
  const invalid = await request();
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_ONBOARDING_INPUT');
  assert.ok(!JSON.stringify(invalid.body).includes(marker));
  assert.equal(accounts.get(ids[0]).onboardingCompleted, false);
  writeError = null; missingUpdate = true;
  assert.equal((await request()).status, 404);
});

test('malformed and oversized onboarding bodies are rejected without logging or echoing input', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const malformed = await request({ raw: `{"uvp":"${marker}"` });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'INVALID_ONBOARDING_INPUT');
  const oversized = await request({ body: { ...validBody(), uvp: marker.repeat(6000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'ONBOARDING_PAYLOAD_TOO_LARGE');
  assert.ok(!JSON.stringify([malformed.body, oversized.body]).includes(marker));
  assert.deepEqual(logged, []);
  assert.deepEqual(writes, []);
  assert.equal(reads, 0);
});
