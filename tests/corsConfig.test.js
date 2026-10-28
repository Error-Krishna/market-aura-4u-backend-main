const assert = require('node:assert/strict');
const { test } = require('node:test');
const readCorsOrigins = require('../src/config/cors');

test('development defaults allow only the two explicit Vite loopback origins', () => {
  assert.deepEqual(readCorsOrigins({}), ['http://localhost:5173', 'http://127.0.0.1:5173']);
});

test('explicit origins replace development defaults, trim separators and remove duplicates', () => {
  assert.deepEqual(readCorsOrigins({ CORS_ALLOWED_ORIGINS:
    ' https://app.example , http://localhost:4173, https://app.example ' }),
  ['https://app.example', 'http://localhost:4173']);
});

test('production requires an explicit allowlist and HTTPS for every entry', () => {
  assert.throws(() => readCorsOrigins({ NODE_ENV: 'production' }), /CORS_ALLOWED_ORIGINS/);
  assert.throws(() => readCorsOrigins({ NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://app.example,http://localhost:5173' }), /HTTPS/);
  assert.deepEqual(readCorsOrigins({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.example' }),
    ['https://app.example']);
});

for (const value of ['', ' ', '*', 'https://*.example.com', 'null',
  'file:///app', 'ftp://app.example', 'not-a-url', 'app.example',
  'https://app.example/', 'https://app.example/path',
  'https://app.example?query=1', 'https://app.example#fragment',
  'https://user:password@app.example', 'https://app.example,',
  'https://app.example,,https://other.example', 'https://APP.example',
  'https://app.example:443', 'https://app.example https://other.example']) {
  test(`rejects unsafe or noncanonical allowlist setting: ${value || '(empty)'}`, () => {
    assert.throws(() => readCorsOrigins({ CORS_ALLOWED_ORIGINS: value }), /CORS_ALLOWED_ORIGINS/);
  });
}
