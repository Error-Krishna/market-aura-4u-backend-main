const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAuthLimiter } = require('../src/utils/authLimiter');
const readAuthConfig = require('../src/config/auth');

function setup(overrides = {}) {
  let time = 0;
  return {
    limiter: createAuthLimiter({
      windowMs: 1000, maxIpAttempts: 2, maxAccountAttempts: 2,
      maxConcurrent: 1, maxTrackedKeys: 2, now: () => time, ...overrides,
    }),
    advance: delta => { time += delta; },
  };
}

test('source-IP attempts use a rolling window and independent identities', () => {
  const { limiter, advance } = setup();
  assert.equal(limiter.consumeIp('127.0.0.1').allowed, true);
  advance(500);
  assert.equal(limiter.consumeIp('127.0.0.1').allowed, true);
  assert.deepEqual(limiter.consumeIp('127.0.0.1'), {
    allowed: false, status: 429, code: 'AUTH_ATTEMPT_LIMIT', retryAfter: 1,
  });
  assert.equal(limiter.consumeIp('127.0.0.2').allowed, true);
  advance(500);
  assert.equal(limiter.consumeIp('127.0.0.1').allowed, true);
  assert.equal(limiter.consumeIp('127.0.0.1').allowed, false);
  advance(500);
  assert.equal(limiter.consumeIp('127.0.0.1').allowed, true);
});

test('account quota is case-insensitive and independent of the source IP', () => {
  const { limiter } = setup();
  limiter.acquireAccount('Person@Example.com').release();
  limiter.acquireAccount('person@example.com').release();
  assert.equal(limiter.acquireAccount('PERSON@example.COM').status, 429);
  assert.equal(limiter.acquireAccount('another@example.com').allowed, true);
});

test('global active checks stay bounded, survive window expiry and release only once', () => {
  const { limiter, advance } = setup();
  const first = limiter.acquireAccount('a@example.com');
  advance(1001);
  assert.equal(limiter.acquireAccount('b@example.com').status, 503);
  first.release();
  const second = limiter.acquireAccount('b@example.com');
  assert.equal(second.allowed, true);
  first.release();
  assert.equal(limiter.acquireAccount('a@example.com').status, 503);
  second.release();
  assert.equal(limiter.acquireAccount('a@example.com').allowed, true);
});

for (const kind of ['ip', 'account']) {
  test(`${kind} registry fails closed at capacity and reclaims expired entries`, () => {
    const { limiter, advance } = setup({ maxTrackedKeys: 1 });
    const enter = key => kind === 'ip' ? limiter.consumeIp(key) : limiter.acquireAccount(`${key}@example.com`);
    const first = enter('a');
    first.release?.();
    assert.equal(enter('b').status, 503);
    const second = enter('a');
    assert.equal(second.allowed, true);
    second.release?.();
    advance(1001);
    assert.equal(enter('b').allowed, true);
  });
}

test('expired account registry entries are reclaimed after work finishes', () => {
  const { limiter, advance } = setup({ maxTrackedKeys: 1 });
  limiter.acquireAccount('a@example.com').release();
  assert.equal(limiter.acquireAccount('b@example.com').status, 503);
  advance(1001);
  assert.equal(limiter.acquireAccount('b@example.com').allowed, true);
});

test('authentication defaults and invalid configuration are explicit', () => {
  assert.deepEqual(readAuthConfig({}), {
    windowMs: 900000, maxIpAttempts: 30, maxAccountAttempts: 10,
    maxConcurrent: 4, maxTrackedKeys: 10000,
  });
  for (const name of ['AUTH_WINDOW_MS', 'AUTH_MAX_IP_ATTEMPTS', 'AUTH_MAX_ACCOUNT_ATTEMPTS',
    'AUTH_MAX_CONCURRENT', 'AUTH_MAX_TRACKED_KEYS']) {
    for (const value of ['0', '-1', '1.5', '', 'NaN', 'Infinity', '999999999999']) {
      assert.throws(() => readAuthConfig({ [name]: value }), new RegExp(name));
    }
  }
});
