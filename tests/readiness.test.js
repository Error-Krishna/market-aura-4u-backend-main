const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { test } = require('node:test');

test('health is liveness while readiness reflects the MongoDB connection', async (t) => {
  const previousState = mongoose.connection.readyState;
  const server = http.createServer(require('../src/app'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(async () => {
    mongoose.connection.readyState = previousState;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const request = (route) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path: route }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });

  mongoose.connection.readyState = 0;
  assert.equal((await request('/health')).status, 200);
  assert.deepEqual(await request('/ready'), {
    status: 503,
    body: { status: 'not_ready', dependencies: { database: 'unavailable' } },
  });

  mongoose.connection.readyState = 1;
  assert.deepEqual(await request('/ready'), { status: 200, body: { status: 'ready' } });
});
