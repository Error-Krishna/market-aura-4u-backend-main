const assert = require('node:assert/strict');
const { test } = require('node:test');
const readConfig = require('../src/config/recommender');
const { createRecommenderClient } = require('../src/utils/recommenderClient');

const audience = 'https://recommender-test-123.us-central1.run.app';
const remoteEnv = { RECOMMENDER_URL: `${audience}/recommend` };
const remote = () => readConfig(remoteEnv);
const payload = { brand_name: 'Offline test', industry: 'beauty' };
const token = (claims = {}) => `e30.${Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.offlineSignature`;
const identity = (value = token()) => new Response(value, { headers: { 'Metadata-Flavor': 'Google' } });

test('loopback development defaults preserve unauthenticated access', () => {
  assert.deepEqual(readConfig({}), {
    recommend: 'http://localhost:8001/recommend', health: 'http://localhost:8001/health',
    timeoutMs: 15000, authMode: 'none', audience: null,
  });
  for (const origin of ['http://127.0.0.1:8001', 'http://[::1]:8001']) {
    assert.equal(readConfig({ RECOMMENDER_URL: `${origin}/recommend` }).authMode, 'none');
  }
});

test('remote service defaults to identity authentication with an origin audience, not a route', () => {
  assert.deepEqual(remote(), {
    recommend: `${audience}/recommend`, health: `${audience}/health`, timeoutMs: 15000,
    authMode: 'cloud-run', audience,
  });
  assert.equal(readConfig({ ...remoteEnv, RECOMMENDER_AUTH_MODE: 'cloud-run', RECOMMENDER_AUDIENCE: audience }).audience, audience);
});

const invalidConfigs = [
  { RECOMMENDER_AUTH_MODE: 'arbitrary' },
  { ...remoteEnv, RECOMMENDER_AUTH_MODE: 'none' },
  { K_SERVICE: 'node-service' },
  { RECOMMENDER_URL: 'http://localhost.attacker.invalid/recommend', RECOMMENDER_AUTH_MODE: 'none' },
  { RECOMMENDER_URL: audience.replace('https:', 'http:') + '/recommend' },
  { ...remoteEnv, RECOMMENDER_AUDIENCE: `${audience}/recommend` },
  { ...remoteEnv, RECOMMENDER_AUDIENCE: `${audience}/` },
  { ...remoteEnv, RECOMMENDER_AUDIENCE: 'https://different-service.run.app' },
  { ...remoteEnv, RECOMMENDER_AUDIENCE: `${audience}?audience=other` },
  { RECOMMENDER_URL: 'https://custom-domain.example/recommend' },
  { RECOMMENDER_URL: 'https://username:password@recommender.run.app/recommend' },
  { ...remoteEnv, RECOMMENDER_HEALTH_URL: 'https://different-service.run.app/health' },
  { RECOMMENDER_URL: 'not-a-url' },
  { RECOMMENDER_URL: 'file:///recommend' },
  { ...remoteEnv, RECOMMENDER_URL: `${audience}/recommend#fragment` },
  { RECOMMENDER_AUDIENCE: audience },
];
invalidConfigs.forEach((env, index) => test(`invalid recommender configuration ${index + 1} fails before network calls`, () => {
  assert.throws(() => readConfig(env), /RECOMMENDER_|Cloud Run|Unauthenticated/);
}));

test('recommender timeouts are bounded integers', () => {
  for (const value of ['0', '-1', '1.5', '15000junk', '', '120001', 'Infinity']) {
    assert.throws(() => readConfig({ RECOMMENDER_TIMEOUT_MS: value }), /RECOMMENDER_TIMEOUT_MS/);
  }
  assert.equal(readConfig({ RECOMMENDER_TIMEOUT_MS: '120000' }).timeoutMs, 120000);
});

test('local request sends only JSON with no metadata call or authorization header', async () => {
  const calls = [];
  const recommend = createRecommenderClient(readConfig({}), { fetchImpl: async (url, options) => {
    calls.push(url);
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), payload);
    return new Response(JSON.stringify({ recommended_topic: 'skincare' }));
  } });
  assert.equal((await recommend(payload)).data.recommended_topic, 'skincare');
  assert.deepEqual(calls, ['http://localhost:8001/recommend']);
});

test('private call acquires a Google ID token with the exact service audience and a shared deadline', async () => {
  const calls = [];
  const serviceToken = token();
  const recommend = createRecommenderClient(remote(), { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (calls.length === 1) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'http://metadata.google.internal');
      assert.equal(parsed.pathname, '/computeMetadata/v1/instance/service-accounts/default/identity');
      assert.equal(parsed.searchParams.get('audience'), audience);
      assert.deepEqual(options.headers, { 'Metadata-Flavor': 'Google' });
      assert.equal(options.method, 'GET');
      return identity(serviceToken);
    }
    assert.equal(url, remoteEnv.RECOMMENDER_URL);
    assert.equal(options.headers.Authorization, `Bearer ${serviceToken}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), payload);
    assert.equal(options.signal, calls[0].options.signal);
    return new Response(JSON.stringify({ recommended_topic: 'skincare' }));
  } });
  assert.equal((await recommend(payload)).data.recommended_topic, 'skincare');
  assert.equal(calls.length, 2);
});

test('each private request obtains a fresh token rather than caching past expiry', async () => {
  let metadataCalls = 0;
  const recommend = createRecommenderClient(remote(), { fetchImpl: async (url) => {
    if (url.startsWith('http://metadata.google.internal/')) { metadataCalls++; return identity(); }
    return new Response('{}');
  } });
  await recommend(payload); await recommend(payload);
  assert.equal(metadataCalls, 2);
});

test('a late metadata result cannot start inference after the deadline', async () => {
  const controller = new AbortController();
  let calls = 0;
  const recommend = createRecommenderClient(remote(), {
    timeoutSignal: () => controller.signal,
    fetchImpl: async () => {
      calls++;
      const response = identity();
      controller.abort(new DOMException('Aborted', 'TimeoutError'));
      return response;
    },
  });
  await assert.rejects(recommend(payload), { name: 'TimeoutError' });
  assert.equal(calls, 1);
});

test('malformed Python JSON does not expose its body or parsing error', async () => {
  let calls = 0;
  const recommend = createRecommenderClient(remote(), { fetchImpl: async () => {
    calls++;
    return calls === 1 ? identity() : new Response('sensitive-malformed-json');
  } });
  await assert.rejects(recommend(payload), { message: 'Recommender service unavailable' });
  assert.equal(calls, 2);
});

for (const status of [401, 403, 500]) {
  test(`metadata HTTP ${status} fails closed without an anonymous call or error-body leak`, async () => {
    let calls = 0;
    const recommend = createRecommenderClient(remote(), { fetchImpl: async () => {
      calls++; return new Response('sensitive-metadata-response', { status });
    } });
    await assert.rejects(recommend(payload), { code: 'RECOMMENDER_AUTH_UNAVAILABLE', message: 'Recommender authentication unavailable' });
    assert.equal(calls, 1);
  });
}

test('missing metadata response flavor is rejected', async () => {
  let calls = 0;
  const recommend = createRecommenderClient(remote(), { fetchImpl: async () => {
    calls++; return new Response(token());
  } });
  await assert.rejects(recommend(payload), { code: 'RECOMMENDER_AUTH_UNAVAILABLE' });
  assert.equal(calls, 1);
});

for (const [label, value] of [
  ['empty', ''], ['malformed', 'sensitive-not-a-token'],
  ['wrong audience', token({ aud: 'https://other.run.app' })],
  ['expired', token({ exp: 1 })], ['missing expiry', token({ exp: null })],
  ['oversized', 'x'.repeat(17000)],
]) {
  test(`${label} identity is rejected before sending a private-service request`, async () => {
    let calls = 0;
    const recommend = createRecommenderClient(remote(), { fetchImpl: async () => { calls++; return identity(value); } });
    await assert.rejects(recommend(payload), { code: 'RECOMMENDER_AUTH_UNAVAILABLE', message: 'Recommender authentication unavailable' });
    assert.equal(calls, 1);
  });
}

for (const status of [401, 403]) {
  test(`private-service HTTP ${status} does not retry or downgrade to unauthenticated access`, async () => {
    let calls = 0;
    const recommend = createRecommenderClient(remote(), { fetchImpl: async () => {
      calls++; return calls === 1 ? identity() : new Response('sensitive-service-body', { status });
    } });
    assert.deepEqual(await recommend(payload), { ok: false, status, data: null });
    assert.equal(calls, 2);
  });
}

for (const phase of ['identity fetch', 'identity body', 'service fetch', 'service body']) {
  test(`${phase} timeout stays inside the shared deadline without retries or credential leaks`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const stall = () => new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('sensitive-error-fragment')), { once: true });
      controller.abort(new DOMException('Aborted', 'TimeoutError'));
    });
    const recommend = createRecommenderClient(remote(), {
      timeoutSignal: ms => { assert.equal(ms, 15000); return controller.signal; },
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          if (phase === 'identity fetch') return stall();
          if (phase === 'identity body') return { ok: true, headers: new Headers({ 'Metadata-Flavor': 'Google' }), text: stall };
          return identity();
        }
        if (phase === 'service fetch') return stall();
        return { ok: true, json: stall };
      },
    });
    await assert.rejects(recommend(payload), { name: 'TimeoutError', message: 'Recommender request timed out' });
    assert.equal(calls, phase.startsWith('identity') ? 1 : 2);
  });
}

for (const phase of ['identity', 'service']) {
  test(`${phase} transport/redirect errors never leak raw credentials`, async () => {
    let calls = 0;
    const recommend = createRecommenderClient(remote(), { fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.redirect, 'error');
      if (phase === 'service' && calls === 1) return identity();
      throw new Error('Authorization: Bearer sensitive-token-marker');
    } });
    await assert.rejects(recommend(payload), error => {
      assert.equal(error.message, phase === 'identity' ? 'Recommender authentication unavailable' : 'Recommender service unavailable');
      return true;
    });
    assert.equal(calls, phase === 'identity' ? 1 : 2);
  });
}
