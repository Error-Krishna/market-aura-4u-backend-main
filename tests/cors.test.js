const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, beforeEach, test, mock } = require('node:test');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const testEnv = {
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://market-aura.example,https://market-aura-preview.example',
  JWT_SECREAT_KEY: 'test-only-cors-key',
};
const originalEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
let server;
let forbiddenCalls;
let token;

before(async () => {
  Object.assign(process.env, testEnv);
  const forbid = name => () => {
    forbiddenCalls.push(name);
    throw new Error(`Unexpected side effect: ${name}`);
  };
  forbiddenCalls = [];
  mock.method(mongoose, 'connect', forbid('database connection'));
  mock.method(User, 'findOne', forbid('account lookup'));
  mock.method(User, 'findById', forbid('account lookup'));
  mock.method(User.prototype, 'save', forbid('account write'));
  mock.method(globalThis, 'fetch', forbid('provider request'));
  token = jwt.sign({ email: 'cors@example.invalid' }, testEnv.JWT_SECREAT_KEY);
  server = http.createServer(require('../src/app'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

beforeEach(() => { forbiddenCalls = []; });
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

function request({ origin, method = 'GET', path = '/health', headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: {
        ...(origin === undefined ? {} : { Origin: origin }),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local request timed out')));
    req.end(data);
  });
}

function assertNoCorsGrant(response) {
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
}

for (const origin of testEnv.CORS_ALLOWED_ORIGINS.split(',')) {
  test(`allows credentials for the exact configured origin ${origin}`, async () => {
    const response = await request({ origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(response.headers.vary, /(?:^|,\s*)Origin(?:,|$)/i);
    assert.match(response.headers['access-control-expose-headers'], /Retry-After/i);
    assert.deepEqual(forbiddenCalls, []);
  });
}

for (const origin of [
  'https://attacker.example', 'https://market-aura.example.attacker.example',
  'https://sub.market-aura.example', 'http://market-aura.example',
  'https://market-aura.example:8443', 'http://localhost:5173',
  'null', '', 'https://market-aura.example/', 'https://market-aura.example@attacker.example',
  'https://market-aura.example https://attacker.example',
]) {
  test(`rejects an unlisted or invalid Origin: ${origin}`, async () => {
    const response = await request({ origin });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ORIGIN_NOT_ALLOWED');
    assertNoCorsGrant(response);
    assert.match(response.headers.vary, /Origin/i);
    assert.deepEqual(forbiddenCalls, []);
  });
}

test('allowed preflight permits only declared methods and headers, without authentication', async () => {
  const response = await request({ origin: 'https://market-aura.example', method: 'OPTIONS',
    path: '/api/v1/content/generate', headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'https://market-aura.example');
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.equal(response.body, null);
  assert.deepEqual(response.headers['access-control-allow-headers'].toLowerCase().split(/,\s*/).sort(), ['authorization', 'content-type']);
  assert.ok(!response.headers['access-control-allow-methods'].includes('*'));
  assert.deepEqual(forbiddenCalls, []);
});

test('preflight does not reflect arbitrary requested headers', async () => {
  const response = await request({ origin: 'https://market-aura.example', method: 'OPTIONS',
    path: '/api/v1/content/generate', headers: {
      'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'x-attacker-header',
    },
  });
  assert.equal(response.headers['access-control-allow-headers'].toLowerCase().includes('x-attacker-header'), false);
  assert.equal(response.headers['access-control-allow-methods'].includes('PATCH'), false);
  assert.deepEqual(forbiddenCalls, []);
});

test('rejects a forbidden preflight before route handlers', async () => {
  const response = await request({ origin: 'https://attacker.example', method: 'OPTIONS',
    path: '/api/v1/content/generate', headers: { 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(response.status, 403);
  assertNoCorsGrant(response);
  assert.deepEqual(forbiddenCalls, []);
});

for (const path of ['/api/v1/auth/login', '/api/v1/auth/signup', '/api/v1/content/generate']) {
  test(`forbidden credentialed POST ${path} cannot reach account or provider work`, async () => {
    const response = await request({ origin: 'https://attacker.example', method: 'POST', path,
      headers: { Cookie: `token=${token}`, Authorization: `Bearer ${token}` },
      body: { email: 'cors@example.invalid', password: 'test-only-password', prompt: 'Create a learning tip' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ORIGIN_NOT_ALLOWED');
    assertNoCorsGrant(response);
    assert.deepEqual(forbiddenCalls, []);
  });
}

test('no-Origin health clients remain supported without CORS grants', async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assertNoCorsGrant(response);
  assert.match(response.headers.vary, /Origin/i);
});

for (const origin of [undefined, 'https://market-aura.example']) {
  test(`protected routes still require authentication (${origin ? 'allowed origin' : 'no Origin'})`, async () => {
    const response = await request({ origin, path: '/api/v1/auth/profile' });
    assert.equal(response.status, 401);
    if (origin) assert.equal(response.headers['access-control-allow-origin'], origin);
    else assertNoCorsGrant(response);
    assert.deepEqual(forbiddenCalls, []);
  });
}

test('allowed-origin session logout keeps its response and cookie clearing contract', async () => {
  const response = await request({ origin: 'https://market-aura.example', method: 'POST', path: '/api/v1/auth/logout' });
  assert.equal(response.status, 200);
  assert.equal(response.body.message, 'user Logged out successfully');
  assert.ok(response.headers['set-cookie'].some(value => value.startsWith('token=;')));
  assert.equal(response.headers['access-control-allow-origin'], 'https://market-aura.example');
});

test('allowed-origin login preserves token and secure cookie contracts', async (t) => {
  t.mock.method(User, 'findOne', async () => ({
    _id: '111111111111111111111111', email: 'cors@example.invalid',
    password: 'test-only-hash', onboardingCompleted: true, isPremium: false,
  }));
  t.mock.method(bcrypt, 'compare', async () => true);
  const response = await request({ origin: 'https://market-aura.example', method: 'POST',
    path: '/api/v1/auth/login', body: { email: 'cors@example.invalid', password: 'test-only-password' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.isOnboarded, true);
  assert.equal(jwt.verify(response.body.token, testEnv.JWT_SECREAT_KEY).email, 'cors@example.invalid');
  const cookie = response.headers['set-cookie'].find(value => value.startsWith('token='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(response.headers['access-control-allow-origin'], 'https://market-aura.example');
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.deepEqual(forbiddenCalls, []);
});
