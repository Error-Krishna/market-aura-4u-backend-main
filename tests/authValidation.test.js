const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const login = require('../src/controllers/auth/login');
const signup = require('../src/controllers/auth/signUp');

let calls;
beforeEach(() => {
  calls = [];
  const forbid = name => () => { calls.push(name); throw new Error(`Unexpected ${name}`); };
  mock.method(User, 'findOne', forbid('account lookup'));
  mock.method(User.prototype, 'save', forbid('account write'));
  mock.method(bcrypt, 'hash', forbid('password hash'));
  mock.method(bcrypt, 'compare', forbid('password compare'));
  mock.method(jwt, 'sign', forbid('token signing'));
});
afterEach(() => mock.restoreAll());

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

for (const [route, handler] of [['login', login], ['signup', signup]]) {
  for (const [name, body] of [
    ['missing body', undefined], ['null body', null], ['array body', []], ['string body', 'credentials'],
    ['missing fields', {}], ['missing password', { email: 'a@example.com' }],
    ['query operator email', { email: { $ne: null }, password: 'password123' }],
    ['array email', { email: ['a@example.com'], password: 'password123' }],
    ['numeric email', { email: 123, password: 'password123' }],
    ['invalid email', { email: 'not-an-email', password: 'password123' }],
    ['spaced email', { email: ' a@example.com ', password: 'password123' }],
    ['email control character', { email: 'a\n@example.com', password: 'password123' }],
    ['email trailing newline', { email: 'a@example.com\n', password: 'password123' }],
    ['oversized email', { email: 'a'.repeat(250) + '@example.com', password: 'password123' }],
    ['object password', { email: 'a@example.com', password: { $ne: null } }],
    ['array password', { email: 'a@example.com', password: ['password123'] }],
    ['numeric password', { email: 'a@example.com', password: 12345678 }],
    ['empty password', { email: 'a@example.com', password: '' }],
    ['privilege override', { email: 'a@example.com', password: 'password123', isPremium: true }],
    ['identity override', { email: 'a@example.com', password: 'password123', userId: 'another-user' }],
  ]) {
    test(`${route} rejects ${name} before account, bcrypt or token work`, async () => {
      const res = response();
      await assert.doesNotReject(() => handler({ body }, res));
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVALID_AUTH_INPUT');
      assert.deepEqual(calls, []);
    });
  }
}

for (const password of ['short', '        ', 'a'.repeat(73), '🌱'.repeat(19)]) {
  test(`signup rejects an unsafe password boundary (${Buffer.byteLength(password)} bytes)`, async () => {
    const res = response();
    await signup({ body: { email: 'a@example.com', password } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_AUTH_INPUT');
    assert.deepEqual(calls, []);
  });
}

test('login rejects an oversized legacy password before bcrypt', async () => {
  const res = response();
  await login({ body: { email: 'a@example.com', password: 'a'.repeat(4097) } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});
