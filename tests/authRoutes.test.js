const assert = require('node:assert/strict');
const http = require('node:http');
const { before, beforeEach, after, test, mock } = require('node:test');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');

const testEnv = {
  NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example',
  JWT_SECREAT_KEY: 'test-only-auth-route-key', AUTH_WINDOW_MS: '60000',
  AUTH_MAX_IP_ATTEMPTS: '60', AUTH_MAX_ACCOUNT_ATTEMPTS: '3',
  AUTH_MAX_CONCURRENT: '1', AUTH_MAX_TRACKED_KEYS: '100',
};
const originalEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
let server;
let calls;
let lookup;
let compare;
let hash;
let savedUsers;
let ipAttempts = 0;
let sequence = 0;

before(async () => {
  Object.assign(process.env, testEnv);
  mock.method(mongoose, 'connect', () => assert.fail('No database connection allowed'));
  mock.method(globalThis, 'fetch', () => assert.fail('No provider calls allowed'));
  mock.method(User, 'findOne', async query => { calls.push('lookup'); return lookup(query); });
  mock.method(User.prototype, 'save', async function () {
    calls.push('save'); savedUsers.push(this); return this;
  });
  mock.method(bcrypt, 'compare', async (...args) => { calls.push('compare'); return compare(...args); });
  mock.method(bcrypt, 'hash', async (...args) => { calls.push('hash'); return hash(...args); });
  server = http.createServer(require('../src/app'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});
beforeEach(() => {
  calls = []; savedUsers = [];
  lookup = async () => null;
  compare = async () => false;
  hash = async () => 'test-only-hash';
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function email() { return `person${++sequence}@example.com`; }
function request({ path = '/api/v1/auth/login', method = 'POST',
  body = { email: email(), password: 'test-password' }, raw, headers = {} } = {}) {
  const text = raw === undefined ? JSON.stringify(body) : raw;
  if (method === 'POST') ipAttempts++;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        Origin: 'https://app.example', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text), ...headers,
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers,
          body: res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local request timed out')));
    req.end(text);
  });
}

test('invalid HTTP payloads return 400 without account or bcrypt work', async () => {
  for (const body of [null, {}, { email: { $ne: null }, password: 'password123' },
    { email: email(), password: 'password123', isPremium: true }]) {
    assert.equal((await request({ body })).status, 400);
  }
  assert.deepEqual(calls, []);
});

test('malformed and oversized credential bodies never echo or log credential fragments', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const fragment = 'test-only-private-password-fragment';
  const malformed = await request({ raw: `{"email":"a@example.com","password":"${fragment}"` });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'INVALID_AUTH_INPUT');
  assert.ok(!JSON.stringify(malformed.body).includes(fragment));
  const oversized = await request({ body: { email: email(), password: fragment.repeat(5000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'AUTH_PAYLOAD_TOO_LARGE');
  assert.ok(!JSON.stringify(oversized.body).includes(fragment));
  assert.deepEqual(logged, []);
  assert.deepEqual(calls, []);
});

test('account attempts are shared across login, signup and email casing', async () => {
  const address = email();
  for (let i = 0; i < 3; i++) {
    const result = await request({ body: { email: i === 1 ? address.toUpperCase() : address, password: 'wrong-password' } });
    assert.equal(result.status, 400);
    assert.equal(result.body.message, 'Invalid credentials');
  }
  calls = [];
  const blocked = await request({ path: '/api/v1/auth/signup', body: { email: address, password: 'password123' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'AUTH_ATTEMPT_LIMIT');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.deepEqual(calls, []);
});

test('invalid account payloads do not spend the email quota', async () => {
  const address = email();
  for (let i = 0; i < 4; i++) {
    assert.equal((await request({ body: { email: address, password: {} } })).status, 400);
  }
  for (let i = 0; i < 3; i++) {
    const response = await request({ body: { email: address, password: 'wrong-password' } });
    assert.equal(response.status, 400);
    assert.equal(response.body.message, 'Invalid credentials');
  }
  assert.equal(calls.length, 3);
});

test('registration preserves password bytes, email case, hash cost, JWT and cookie contracts', async () => {
  for (const password of [' password ', 'a'.repeat(72), '🌱'.repeat(18)]) {
    const address = `Case${++sequence}@Example.com`;
    hash = async (value, cost) => {
      assert.equal(value, password);
      assert.equal(cost, 10);
      return 'test-only-hash';
    };
    const response = await request({ path: '/api/v1/auth/signup', body: { email: address, password } });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.email, address);
    assert.equal(response.body.data.isOnboarded, false);
    assert.equal(response.body.data.isPremium, false);
    assert.equal(jwt.verify(response.body.token, testEnv.JWT_SECREAT_KEY).email, address);
    assert.equal(savedUsers.at(-1).password, 'test-only-hash');
    const cookie = response.headers['set-cookie'].find(value => value.startsWith('token='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
  }
});

test('login preserves legacy short and long password verification and success does not reset quotas', async () => {
  const address = email();
  lookup = async ({ email: value }) => {
    assert.equal(value, address);
    return { _id: '111111111111111111111111', email: address, password: 'test-hash', onboardingCompleted: true };
  };
  for (const password of ['x', 'a'.repeat(73), 'b'.repeat(4096)]) {
    compare = async (value, stored) => {
      assert.equal(value, password);
      assert.equal(stored, 'test-hash');
      return true;
    };
    const response = await request({ body: { email: address, password } });
    assert.equal(response.status, 200);
    assert.equal(jwt.verify(response.body.token, testEnv.JWT_SECREAT_KEY).email, address);
    assert.equal(response.body.data.isOnboarded, true);
  }
  calls = [];
  assert.equal((await request({ body: { email: address, password: 'correct-password' } })).status, 429);
  assert.deepEqual(calls, []);
});

test('active credential work is bounded across both routes and a finished request releases its slot', async () => {
  let unblock;
  let entered;
  const gate = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  lookup = async () => { entered(); await gate; return null; };
  const running = request();
  await started;
  try {
    const blocked = await request({ path: '/api/v1/auth/signup' });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, 'AUTH_CAPACITY');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.deepEqual(calls, ['lookup']);
  } finally { unblock(); await running; }
  lookup = async () => null;
  assert.equal((await request()).status, 400);
});

test('unknown accounts and wrong passwords retain the same invalid-credentials response', async () => {
  const unknown = await request();
  lookup = async () => ({ password: 'test-only-hash' });
  const wrong = await request();
  assert.equal(unknown.status, 400);
  assert.equal(wrong.status, 400);
  assert.deepEqual(unknown.body, wrong.body);
  assert.equal(wrong.body.message, 'Invalid credentials');
});

test('an existing signup account retains the rejection contract and avoids hashing or writing', async () => {
  lookup = async () => ({ _id: '111111111111111111111111' });
  const result = await request({ path: '/api/v1/auth/signup' });
  assert.equal(result.status, 400);
  assert.equal(result.body.message, 'User already exists');
  assert.deepEqual(calls, ['lookup']);
});

test('database and bcrypt failures return generic errors and release the active slot', async () => {
  for (const failAt of ['lookup', 'compare', 'hash', 'save']) {
    if (failAt === 'lookup') lookup = async () => { throw new Error('test-only-private-details'); };
    if (failAt === 'compare') {
      lookup = async () => ({ password: 'test-hash' });
      compare = async () => { throw new Error('test-only-private-details'); };
    }
    if (failAt === 'hash') {
      lookup = async () => null;
      hash = async () => { throw new Error('test-only-private-details'); };
    }
    if (failAt === 'save') {
      hash = async () => 'test-only-hash';
      mock.method(User.prototype, 'save', async () => { throw new Error('test-only-private-details'); });
    }
    const result = await request({ path: failAt === 'hash' || failAt === 'save' ? '/api/v1/auth/signup' : '/api/v1/auth/login' });
    assert.equal(result.status, 500);
    assert.ok(!JSON.stringify(result.body).includes('test-only-private-details'));
  }
  lookup = async () => null;
  assert.equal((await request()).status, 400);
});

test('database failure during token account lookup returns a dependency error, not an auth failure', async () => {
  lookup = async () => { throw new Error('test-only-private-details'); };
  const token = jwt.sign({ email: 'existing@example.com' }, testEnv.JWT_SECREAT_KEY);
  const result = await request({
    path: '/api/v1/content/history',
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
  assert.ok(!JSON.stringify(result.body).includes('test-only-private-details'));
});

// Keep this last: it intentionally exhausts this process's real loopback-IP quota.
test('IP limits include malformed JSON, share route aliases, and ignore spoofed forwarding headers', async () => {
  assert.ok(ipAttempts < 60);
  while (ipAttempts < 60) {
    const result = await request({ raw: '{', headers: { 'X-Forwarded-For': `203.0.113.${ipAttempts}` } });
    assert.equal(result.status, 400);
  }
  calls = [];
  for (const path of ['/api/v1/auth/login', '/API/v1/AUTH/SIGNUP/?next=ignored']) {
    const result = await request({ path, raw: '{',
      headers: { 'X-Forwarded-For': '198.51.100.50', Forwarded: 'for=198.51.100.51' },
    });
    assert.equal(result.status, 429, 'The IP guard must run before JSON parsing');
    assert.equal(result.body.code, 'AUTH_ATTEMPT_LIMIT');
    assert.ok(Number(result.headers['retry-after']) > 0);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request({ path: '/health', method: 'GET' })).status, 200);
});
