const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, beforeEach, test, mock } = require('node:test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Job = require('../src/models/Job');

const testEnv = {
  JWT_SECREAT_KEY: 'test-only-generation-route-secret',
  GROQ_API_KEY: 'test-only-provider-key',
  GROQ_TIMEOUT_MS: '40', GENERATION_MAX_REQUESTS: '2',
  GENERATION_WINDOW_MS: '60000', GENERATION_MAX_CONCURRENT: '1', GENERATION_MAX_USERS: '100',
};
const originalEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
let server;
let users;
let currentUser;
let sequence = 0;
let providerCalls;
let jobs;
let groq;
let updates;

before(async () => {
  Object.assign(process.env, testEnv);
  mock.method(mongoose, 'connect', () => assert.fail('No database connection allowed'));
  mock.method(User, 'findOne', async ({ email }) => [...users.values()].find(user => user.email === email));
  mock.method(User, 'findById', async id => users.get(String(id)));
  mock.method(Job.prototype, 'save', async function () { jobs.push(this); return this; });
  mock.method(Job, 'findByIdAndUpdate', async (_id, update) => {
    updates.push(update);
    return { _id, ...update };
  });
  mock.method(globalThis, 'fetch', async (url, options) => {
    providerCalls.push(url.includes('recommend') ? 'recommender' : 'groq');
    if (url.includes('recommend')) return { ok: true, json: async () => ({ recommended_topic: 'Learning' }) };
    assert.ok(url.includes('groq.com'));
    return groq(options);
  });
  server = http.createServer(require('../src/app'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

beforeEach(() => {
  const id = (++sequence).toString(16).padStart(24, '0');
  currentUser = {
    id, email: `${id}@example.invalid`, onboardingCompleted: true,
    brandProfile: {
      companyName: 'Test brand', industry: 'Education', uvp: 'Practical lessons',
      targetAudience: 'Adult learners', platforms: ['twitter'],
    },
  };
  users = new Map([[id, currentUser]]);
  providerCalls = [];
  jobs = [];
  updates = [];
  groq = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"twitter":[{"text":"Learn today."}]}' } }] }),
  });
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

function request({ body = { prompt: 'Create a learning tip' }, cookie = false, authenticated = true } = {}) {
  const text = JSON.stringify(body);
  // A fresh JWT with a different claim ID must still share the DB account's quota.
  const token = jwt.sign({ email: currentUser.email, id: `ignored-${Math.random()}` }, testEnv.JWT_SECREAT_KEY);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: '/api/v1/content/generate', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
        ...(authenticated ? (cookie ? { Cookie: `token=${token}` } : { Authorization: `Bearer ${token}` }) : {}),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local request timed out')));
    req.end(text);
  });
}

test('real route requires authentication and onboarding before providers', async () => {
  assert.equal((await request({ authenticated: false })).status, 401);
  currentUser.onboardingCompleted = false;
  assert.equal((await request()).status, 403);
  assert.deepEqual(providerCalls, []);
  assert.equal(jobs.length, 0);
});

test('invalid requests do not spend quota; cookie and bearer tokens share the account limit', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await request({ body: { prompt: 123 } })).status, 400);
  assert.deepEqual(providerCalls, []);
  assert.equal((await request()).status, 200);
  assert.equal((await request({ cookie: true })).status, 200);
  const blocked = await request();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'GENERATION_RATE_LIMIT');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(providerCalls.length, 4);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(job => String(job.userId) === currentUser.id));
});

for (const phase of ['fetch', 'body']) {
  test(`Groq ${phase} timeout returns 504 and releases the slot for a retry`, async () => {
    const success = groq;
    let timeoutSignal;
    groq = async ({ signal }) => {
      assert.ok(signal instanceof AbortSignal, 'Groq must receive a deadline signal');
      timeoutSignal = signal;
      const stalled = () => new Promise((resolve, reject) => {
        // Native fetch can report AbortError while consuming the response body.
        const fail = () => reject(phase === 'body' ? new DOMException('Aborted', 'AbortError') : signal.reason);
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
      return phase === 'fetch' ? stalled() : { ok: true, json: stalled };
    };
    const response = await request();
    assert.equal(response.status, 504);
    assert.equal(response.body.code, 'GENERATION_TIMEOUT');
    assert.equal(updates.at(-1).error, 'Content generation timed out. Please try again later.');
    assert.equal(timeoutSignal.aborted, true);
    groq = success;
    assert.equal((await request()).status, 200);
  });
}

for (const phase of ['http', 'transport', 'json', 'content', 'save', 'complete', 'failure-write']) {
  test(`generation ${phase} failure does not expose or persist private diagnostics`, async t => {
    const privateDetail = 'PRIVATE_TEST_DIAGNOSTIC credential=fixture-only prompt=private';
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    let discarded = false;
    let readErrorBody = false;
    const success = groq;
    if (phase === 'http') {
      groq = async () => ({
        ok: false, status: 429,
        body: { cancel: async () => { discarded = true; } },
        text: async () => { readErrorBody = true; return privateDetail; },
      });
    } else if (phase === 'transport' || phase === 'failure-write') {
      groq = async () => { throw new Error(privateDetail); };
    } else if (phase === 'json') {
      groq = async () => ({ ok: true, json: async () => { throw new Error(privateDetail); } });
    } else if (phase === 'content') {
      groq = async () => ({ ok: true, json: async () => ({
        choices: [{ message: { content: privateDetail } }],
      }) });
    } else if (phase === 'save') {
      t.mock.method(Job.prototype, 'save', async () => { throw new Error(privateDetail); });
    }
    if (phase === 'complete' || phase === 'failure-write') {
      t.mock.method(Job, 'findByIdAndUpdate', async (_id, update) => {
        updates.push(update);
        if (update.status === (phase === 'complete' ? 'completed' : 'failed')) {
          throw new Error(privateDetail);
        }
        return { _id, ...update };
      });
    }
    const response = await request();
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      success: false, code: 'GENERATION_FAILED', message: 'Generation failed', error: 'Generation failed',
    });
    assert.ok(errors.length > 0, 'a safe failure event remains observable');
    assert.equal(JSON.stringify(errors).includes(privateDetail), false);
    assert.equal(JSON.stringify(updates).includes(privateDetail), false);
    if (phase !== 'save') {
      assert.equal(updates.at(-1).status, 'failed');
      assert.equal(updates.at(-1).error, 'Generation failed');
    } else {
      assert.deepEqual(providerCalls, ['recommender'], 'a save failure prevents a Groq call');
    }
    if (phase === 'http') {
      assert.equal(discarded, true);
      assert.equal(readErrorBody, false);
    }
    if (['http', 'transport', 'json', 'content'].includes(phase)) {
      groq = success;
      assert.equal((await request()).status, 200, 'failure releases the concurrency slot');
    }
  });
}
