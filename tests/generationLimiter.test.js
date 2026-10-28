const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createGenerationLimiter } = require('../src/utils/generationLimiter');
const readGenerationConfig = require('../src/config/generation');

function setup(overrides = {}) {
  let time = 0;
  return {
    limiter: createGenerationLimiter({
      maxRequests: 2, windowMs: 1000, maxConcurrent: 1, maxUsers: 2,
      now: () => time, ...overrides,
    }),
    advance: (milliseconds) => { time += milliseconds; },
  };
}

test('rolling per-user quota rejects excess requests and expires each admission separately', () => {
  const { limiter, advance } = setup();
  limiter.acquire('alice').release();
  advance(500);
  limiter.acquire('alice').release();
  assert.deepEqual(limiter.acquire('alice'), {
    allowed: false, code: 'GENERATION_RATE_LIMIT', retryAfter: 1, status: 429,
  });
  assert.equal(limiter.acquire('bob').allowed, true);
  advance(500);
  limiter.acquire('alice').release();
  assert.equal(limiter.acquire('alice').code, 'GENERATION_RATE_LIMIT');
  advance(500);
  assert.equal(limiter.acquire('alice').allowed, true);
});

test('active slots survive rate-window expiry; duplicate release cannot unlock another request', () => {
  const { limiter, advance } = setup();
  const first = limiter.acquire('alice');
  advance(1001);
  assert.equal(limiter.acquire('alice').code, 'GENERATION_IN_PROGRESS');
  first.release();
  const second = limiter.acquire('alice');
  assert.equal(second.allowed, true);
  first.release();
  assert.equal(limiter.acquire('alice').code, 'GENERATION_IN_PROGRESS');
  second.release();
  assert.equal(limiter.acquire('alice').allowed, true);
});

test('configured concurrency is enforced atomically and denials do not consume request quota', () => {
  const { limiter } = setup({ maxConcurrent: 2, maxRequests: 3 });
  const first = limiter.acquire('alice');
  const second = limiter.acquire('alice');
  for (let i = 0; i < 20; i++) assert.equal(limiter.acquire('alice').code, 'GENERATION_IN_PROGRESS');
  first.release();
  assert.equal(limiter.acquire('alice').allowed, true);
  second.release();
  assert.equal(limiter.acquire('alice').code, 'GENERATION_RATE_LIMIT');
});

test('bounded user registry fails closed without evicting active users or unexpired quotas', () => {
  const { limiter, advance } = setup();
  const active = limiter.acquire('alice');
  limiter.acquire('bob').release();
  assert.deepEqual(limiter.acquire('charlie'), {
    allowed: false, code: 'GENERATION_CAPACITY', retryAfter: 1, status: 503,
  });
  advance(1001);
  assert.equal(limiter.acquire('charlie').allowed, true);
  assert.equal(limiter.acquire('alice').code, 'GENERATION_IN_PROGRESS');
  active.release();
});

test('safe defaults and explicit configuration are supported', () => {
  assert.deepEqual(readGenerationConfig({}), {
    maxRequests: 10, windowMs: 60000, maxConcurrent: 1, maxUsers: 10000,
    groqTimeoutMs: 45000, groqMaxOutputTokens: 1536,
  });
  assert.equal(readGenerationConfig({ GENERATION_MAX_REQUESTS: '3' }).maxRequests, 3);
});

test('invalid settings fail startup rather than disabling protection', () => {
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '1e3', '100000000000']) {
    for (const name of ['GENERATION_MAX_REQUESTS', 'GENERATION_WINDOW_MS',
      'GENERATION_MAX_CONCURRENT', 'GENERATION_MAX_USERS', 'GROQ_TIMEOUT_MS',
      'GROQ_MAX_OUTPUT_TOKENS']) {
      assert.throws(() => readGenerationConfig({ [name]: value }), new RegExp(name));
    }
  }
});
