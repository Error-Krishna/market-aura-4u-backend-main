const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, test } = require('node:test');
const readConfig = require('../src/config/authProxy');
const { createAuthClientIpResolver } = require('../src/utils/authClientIp');

const env = {
  K_SERVICE: 'offline-cloud-run-test', NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://pilot.example.invalid',
  AUTH_PROXY_MODE: 'direct', AUTH_TRUSTED_PROXY_CIDRS: '',
  AUTH_MAX_IP_ATTEMPTS: '12', AUTH_MAX_ACCOUNT_ATTEMPTS: '2',
  AUTH_MAX_CONCURRENT: '1', AUTH_MAX_TRACKED_KEYS: '100', AUTH_WINDOW_MS: '60000',
  RECOMMENDER_URL: 'https://recommender.example.run.app/recommend',
  RECOMMENDER_HEALTH_URL: 'https://recommender.example.run.app/health',
  RECOMMENDER_AUTH_MODE: 'cloud-run', RECOMMENDER_AUDIENCE: 'https://recommender.example.run.app',
};
const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
let server;
let app;
let lookups = 0;
let attempts = 0;
let lookup = async () => null;

before(async t => {
  Object.assign(process.env, env);
  const mongoose = require('mongoose');
  const bcrypt = require('bcrypt');
  const User = require('../src/models/User');
  t.mock.method(mongoose, 'connect', () => assert.fail('No database connection allowed'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('No provider or metadata calls allowed'));
  t.mock.method(User.prototype, 'save', () => assert.fail('No account writes allowed'));
  t.mock.method(bcrypt, 'hash', () => assert.fail('Denied signup must not hash a password'));
  t.mock.method(bcrypt, 'compare', () => assert.fail('Unknown accounts must not compare passwords'));
  t.mock.method(User, 'findOne', async () => { lookups++; return lookup(); });
  app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function request({ email = 'other@example.invalid', raw, path = '/api/v1/auth/login', method = 'POST', headers = {} } = {}) {
  if (method === 'POST') attempts++;
  const body = raw ?? JSON.stringify({ email, password: 'offline-password' });
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, incoming => {
      let text = '';
      incoming.on('data', part => { text += part; });
      incoming.on('end', () => {
        try { resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(method === 'POST' ? body : undefined);
  });
}

test('explicit Cloud Run peer-IP fallback loads and serves the app without enabling Express proxy trust', async () => {
  assert.equal(app.get('trust proxy'), false);
  const health = await request({ path: '/health', method: 'GET' });
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(lookups, 0);
});

test('Cloud Run direct mode ignores forged addresses and every forwarding chain; unusable peers still fail closed', () => {
  const resolve = createAuthClientIpResolver(readConfig(env));
  for (const forwarded of [undefined, '', '198.51.100.1', 'unknown',
    '203.0.113.1, 198.51.100.2, 10.0.0.8', Array(33).fill('10.0.0.8').join(','), 'x'.repeat(4097),
    ['198.51.100.1', '198.51.100.2']]) {
    const req = {
      socket: { remoteAddress: '::ffff:192.0.2.5' }, ip: '203.0.113.99',
      headers: { 'x-forwarded-for': forwarded, forwarded: 'for=203.0.113.99',
        'x-real-ip': '203.0.113.98', 'x-client-ip': '203.0.113.97' },
    };
    assert.equal(resolve(req), '192.0.2.5');
    assert.equal(resolve({ ...req, socket: {} }), null);
    assert.equal(resolve({ ...req, socket: { remoteAddress: 'unknown' } }), null);
  }
});

test('Cloud Run fallback preserves account and active-work bounds, and spoofed headers cannot escape the shared peer quota', { timeout: 10000 }, async () => {
  assert.equal((await request({ email: 'target@example.invalid' })).status, 400);
  assert.equal((await request({ email: 'TARGET@example.invalid', headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 400);
  const beforeAccountDenial = lookups;
  const accountDenied = await request({ email: 'target@example.invalid', path: '/api/v1/auth/signup',
    headers: { Forwarded: 'for=198.51.100.2', 'X-Real-IP': '198.51.100.3' } });
  assert.equal(accountDenied.status, 429);
  assert.equal(accountDenied.body.code, 'AUTH_ATTEMPT_LIMIT');
  assert.ok(Number(accountDenied.headers['retry-after']) > 0);
  assert.equal(lookups, beforeAccountDenial, 'account denial precedes database/hash work');

  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  lookup = () => { entered(); return held; };
  const pending = request({ email: 'slow@example.invalid' });
  try {
    await started;
    const beforeCapacityDenial = lookups;
    const busy = await request({ email: 'parallel@example.invalid' });
    assert.equal(busy.status, 503);
    assert.equal(busy.body.code, 'AUTH_CAPACITY');
    assert.equal(lookups, beforeCapacityDenial);
  } finally {
    lookup = async () => null;
    release(null);
    assert.equal((await pending).status, 400);
  }
  assert.equal((await request({ email: 'released@example.invalid' })).status, 400, 'finished work releases its slot');

  const beforeMalformed = lookups;
  while (attempts < Number(env.AUTH_MAX_IP_ATTEMPTS)) {
    const malformed = await request({ raw: '{', headers: {
      'X-Forwarded-For': `203.0.113.${attempts}, 198.51.100.1`,
      Forwarded: `for=203.0.113.${attempts}`, 'X-Real-IP': `192.0.2.${attempts}`,
    } });
    assert.equal(malformed.status, 400, 'malformed bodies spend the peer budget before parsing');
    assert.equal(malformed.body.code, 'INVALID_AUTH_INPUT');
  }
  assert.equal(lookups, beforeMalformed);
  for (const path of ['/api/v1/auth/login', '/API/v1/AUTH/SIGNUP/']) {
    const blocked = await request({ path, email: 'fresh@example.invalid', headers: {
      'X-Forwarded-For': '198.51.100.222', Forwarded: 'for=198.51.100.223',
      'X-Real-IP': '198.51.100.224', 'X-Forwarded-Host': 'spoof.example', 'X-Forwarded-Proto': 'https',
    } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'AUTH_ATTEMPT_LIMIT');
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal(lookups, beforeMalformed, 'peer denial precedes account work despite a fresh email and headers');
  }
  assert.equal((await request({ path: '/health', method: 'GET' })).status, 200);
  assert.equal((await request({ path: '/api/v1/auth/profile', method: 'GET' })).status, 401);
});
