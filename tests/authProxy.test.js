const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, test } = require('node:test');
const readConfig = require('../src/config/authProxy');
const { createAuthClientIpResolver, normalizeIp } = require('../src/utils/authClientIp');

const config = { mode: 'trusted-cidrs', cidrs: ['127.0.0.1/32', '10.0.0.0/24', '2001:db8:1::/64'] };
const resolve = createAuthClientIpResolver(config);
const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

test('proxy trust is disabled by default and Cloud Run requires an explicit limiting policy', () => {
  assert.deepEqual(readConfig({}), { mode: 'direct', cidrs: [] });
  assert.throws(() => readConfig({ K_SERVICE: 'test-service' }), /explicit AUTH_PROXY_MODE/);
  assert.deepEqual(readConfig({ K_SERVICE: 'test-service', AUTH_PROXY_MODE: 'direct' }),
    { mode: 'direct', cidrs: [] });
  assert.deepEqual(readConfig({ K_SERVICE: 'test-service', AUTH_PROXY_MODE: 'trusted-cidrs', AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }),
    { mode: 'trusted-cidrs', cidrs: ['127.0.0.1/32'] });
});

test('proxy configuration accepts only bounded explicit CIDRs', () => {
  for (const value of ['*', 'true', 'loopback', 'localhost', '0.0.0.0/0', '::/0', '1.2.3.4/33',
    '::1/129', '10.0.0.1', '10.0.0.1/1.5', '10.0.0.1/24,', '10.0.0.1:123/32', 'fe80::1%eth0/64', '::ffff:10.0.0.1/120',
    '0:0:0:0:0:ffff:10.0.0.1/120']) {
    assert.throws(() => readConfig({ AUTH_PROXY_MODE: 'trusted-cidrs', AUTH_TRUSTED_PROXY_CIDRS: value }), /AUTH_TRUSTED_PROXY_CIDRS/);
  }
  for (const mode of ['true', '1', 'cloud-run', '']) assert.throws(() => readConfig({ AUTH_PROXY_MODE: mode }), /AUTH_PROXY_MODE/);
  assert.throws(() => readConfig({ AUTH_PROXY_MODE: 'trusted-cidrs' }), /AUTH_TRUSTED_PROXY_CIDRS/);
  assert.throws(() => readConfig({ AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }), /requires trusted-cidrs/);
  assert.throws(() => readConfig({ K_SERVICE: 'test-service', AUTH_PROXY_MODE: 'direct', AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }), /requires trusted-cidrs/);
  assert.throws(() => readConfig({ AUTH_PROXY_MODE: 'trusted-cidrs', AUTH_TRUSTED_PROXY_CIDRS: Array(65).fill('127.0.0.1/32').join(',') }), /between 1 and 64/);
});

test('IPv4, mapped IPv6 and IPv6 spellings normalize to stable quota keys', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIp('::ffff:c000:201'), '192.0.2.1');
  assert.equal(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  for (const value of ['192.0.2.1:123', '[2001:db8::1]:123', 'fe80::1%eth0', 'unknown', '192.000.2.1', '', null]) {
    assert.equal(normalizeIp(value), null);
  }
});

test('direct and untrusted peers cannot pick a client quota using forwarding headers', () => {
  const direct = createAuthClientIpResolver({ mode: 'direct', cidrs: [] });
  assert.equal(direct(req('::ffff:127.0.0.1', '198.51.100.1')), '127.0.0.1');
  assert.equal(resolve(req('198.51.100.5', '198.51.100.99')), '198.51.100.5');
  assert.equal(resolve(req('198.51.100.5', 'invalid')), '198.51.100.5');
});

test('trusted chains stop at the first untrusted hop, ignoring attacker prefixes', () => {
  assert.equal(resolve(req('127.0.0.1', '198.51.100.1')), '198.51.100.1');
  assert.equal(resolve(req('127.0.0.1', 'forged-value, 198.51.100.1, 10.0.0.8')), '198.51.100.1');
  assert.equal(resolve(req('127.0.0.1', '203.0.113.1, 198.51.100.1, 2001:db8:1::8')), '198.51.100.1');
  assert.equal(resolve(req('127.0.0.1', '203.0.113.1, 10.0.1.8')), '10.0.1.8', 'addresses outside the trusted subnet are client boundaries');
});

test('missing, invalid, oversized and all-trusted chains fail closed', () => {
  for (const forwarded of [undefined, '', 'unknown', '198.51.100.1:123', '198.51.100.1, invalid',
    '127.0.0.1,10.0.0.8', 'x'.repeat(4097), Array(33).fill('10.0.0.8').join(',')]) {
    assert.equal(resolve(req('127.0.0.1', forwarded)), null);
  }
  assert.equal(resolve({ socket: {}, headers: {} }), null);
});

const env = {
  AUTH_PROXY_MODE: 'trusted-cidrs', AUTH_TRUSTED_PROXY_CIDRS: config.cidrs.join(','),
  AUTH_MAX_IP_ATTEMPTS: '2', AUTH_MAX_ACCOUNT_ATTEMPTS: '50', AUTH_MAX_CONCURRENT: '4',
  AUTH_MAX_TRACKED_KEYS: '100', AUTH_WINDOW_MS: '60000',
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
let server;
let lookups = 0;
let sequence = 0;
before(async t => {
  Object.assign(process.env, env);
  const User = require('../src/models/User');
  t.mock.method(User, 'findOne', async () => { lookups++; return null; });
  const app = require('../src/app');
  assert.equal(app.get('trust proxy'), false, 'Only auth source-IP handling changes; global host/protocol trust stays disabled');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function request(forwarded, { raw, route = '/api/v1/auth/login', method = 'POST', headers = {} } = {}) {
  const text = raw ?? JSON.stringify({ email: `proxy-${++sequence}@example.invalid`, password: 'offline-password' });
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { 'Content-Type': 'application/json', ...(forwarded === undefined ? {} : { 'X-Forwarded-For': forwarded }), ...headers },
    }, incoming => {
      let body = ''; incoming.on('data', part => { body += part; });
      incoming.on('end', () => { try { resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject); outgoing.end(method === 'POST' ? text : undefined);
  });
}

test('HTTP authentication separates verified client IPs behind the same proxy', async () => {
  for (const client of ['198.51.100.10', '198.51.100.11']) {
    assert.equal((await request(client)).status, 400);
    assert.equal((await request(client)).status, 400);
  }
  const before = lookups;
  const blocked = await request('198.51.100.10');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'AUTH_ATTEMPT_LIMIT');
  assert.equal(lookups, before);
});

test('HTTP spoofed prefixes cannot rotate the quota after a trusted proxy appends the real client', async () => {
  assert.equal((await request('203.0.113.1, 198.51.100.12, 10.0.0.8')).status, 400);
  assert.equal((await request('203.0.113.2, 198.51.100.12, 10.0.0.8')).status, 400);
  assert.equal((await request('203.0.113.3, 198.51.100.12, 10.0.0.8')).status, 429);
});

test('HTTP mapped addresses and IPv6 aliases share quota instead of creating new identities', async () => {
  assert.equal((await request('198.51.100.14')).status, 400);
  assert.equal((await request('::ffff:198.51.100.14')).status, 400);
  assert.equal((await request('::ffff:c633:640e')).status, 429);
  assert.equal((await request('2001:db8:2::1')).status, 400);
  assert.equal((await request('2001:0db8:0002:0000:0000:0000:0000:0001')).status, 400);
  assert.equal((await request('2001:db8:2::1')).status, 429);
});

test('HTTP malformed payloads spend the verified IP budget before JSON parsing', async () => {
  for (let index = 0; index < 2; index++) assert.equal((await request('198.51.100.15', { raw: '{' })).status, 400);
  const before = lookups;
  const blocked = await request('198.51.100.15', { raw: '{', route: '/API/v1/AUTH/SIGNUP/' });
  assert.equal(blocked.status, 429);
  assert.equal(lookups, before);
});

test('HTTP unverified chains are rejected before account work without echoing headers or payloads', async () => {
  const before = lookups;
  for (const forwarded of [undefined, 'sensitive-proxy-marker', '', '10.0.0.8', '192.0.2.1:123']) {
    const result = await request(forwarded, { raw: '{sensitive-body-marker', headers: { Forwarded: 'for=198.51.100.16' } });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'AUTH_CLIENT_IP_UNVERIFIED');
    assert.equal(result.headers['retry-after'], '1');
    assert.equal(JSON.stringify(result.body).includes('sensitive-'), false);
  }
  assert.equal(lookups, before);
  assert.equal((await request(undefined, { method: 'GET', route: '/health' })).status, 200);
});
