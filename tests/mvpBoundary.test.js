const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, beforeEach, test, mock } = require('node:test');
const mongoose = require('mongoose');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const Job = require('../src/models/Job');

let server;
let token;
let forbiddenCalls = [];
const originalJwtSecret = process.env.JWT_SECREAT_KEY;

before(async () => {
  const forbid = (name) => () => {
    forbiddenCalls.push(name);
    throw new Error(`Unexpected side effect: ${name}`);
  };
  mock.method(mongoose, 'connect', forbid('MongoDB connection'));
  for (const method of ['findById', 'findOne', 'findByIdAndUpdate']) {
    mock.method(User, method, forbid(`User.${method}`));
  }
  mock.method(Job, 'findOne', forbid('Job.findOne'));
  for (const method of ['get', 'post', 'request']) {
    mock.method(axios, method, forbid(`axios.${method}`));
  }
  mock.method(globalThis, 'fetch', forbid('fetch'));
  process.env.JWT_SECREAT_KEY = 'test-only-mvp-boundary-secret';
  token = jwt.sign({ id: '111111111111111111111111', email: 'test@example.invalid' },
    process.env.JWT_SECREAT_KEY);

  // Import the production application without loading .env or connecting to MongoDB.
  const app = require('../src/app');
  assert.deepEqual(forbiddenCalls, []);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  mock.restoreAll();
  if (originalJwtSecret === undefined) delete process.env.JWT_SECREAT_KEY;
  else process.env.JWT_SECREAT_KEY = originalJwtSecret;
});

beforeEach(() => { forbiddenCalls = []; });

function request(method, url, authenticated = false, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: url, method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local request timed out')));
    req.end(body);
  });
}

const disabledEndpoints = [
  ['POST', '/api/v1/publish/instagram'],
  ['POST', '/api/v1/content/publish'],
  ['GET', '/api/v1/auth/instagram/login?userId=222222222222222222222222'],
  ['GET', '/api/v1/auth/instagram/callback?code=test-code&state=222222222222222222222222'],
  ['POST', '/api/v1/auth/instagram/disconnect'],
  ['POST', '/api/v1/user/payment/create-order'],
  ['POST', '/api/v1/user/payment/verify'],
  ['POST', '/api/v1/payments/payment/create-order'],
  ['POST', '/api/v1/payments/payment/verify'],
];

for (const [method, url] of disabledEndpoints) {
  for (const authenticated of [false, true]) {
    test(`${method} ${url} is disabled (${authenticated ? 'signed JWT' : 'anonymous'})`, async () => {
      const response = await request(method, url, authenticated, {
        userId: '222222222222222222222222', jobId: '333333333333333333333333',
        platforms: ['instagram', 'twitter'], imageUrl: 'https://example.invalid/image.jpg',
        caption: 'Test content', amount: 1, planName: 'enterprise',
        razorpay_order_id: 'test-order', razorpay_payment_id: 'test-payment',
        razorpay_signature: 'test-signature',
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.success, false);
      assert.equal(response.body.code, 'FEATURE_DISABLED');
      assert.match(response.body.message, /unavailable.*MVP/i);
      assert.equal(response.headers.location, undefined);
      assert.deepEqual(forbiddenCalls, [], 'Disabled features must not access accounts or providers');
    });
  }
}

test('health remains reachable without connecting to MongoDB', async () => {
  const response = await request('GET', '/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.deepEqual(forbiddenCalls, []);
});

for (const [method, url, payload] of [
  ['GET', '/api/v1/auth/profile'],
  ['POST', '/api/v1/auth/onboarding', {}],
  ['POST', '/api/v1/content/generate', { prompt: 'Test content idea' }],
  ['GET', '/api/v1/content/history'],
]) {
  test(`${method} ${url} still requires authentication`, async () => {
    const response = await request(method, url, false, payload);
    assert.equal(response.status, 401);
    assert.deepEqual(forbiddenCalls, []);
  });
}
