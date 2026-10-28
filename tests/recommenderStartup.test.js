const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { waitForRecommender } = require('./helpers/waitForRecommender');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  return { child, url: `http://127.0.0.1:${server.address().port}/health`,
    startupTimeoutMs: 300, probeTimeoutMs: 50, pollMs: 5 };
}
const healthy = { status: 'ok', model_version: 'v1.0' };
const reply = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

test('waits for actual model readiness rather than accepting a listening/loading server', async t => {
  let requests = 0;
  const options = await fixture(t, (_req, res) => {
    requests++;
    if (requests < 3) { res.writeHead(503); res.end('loading'); }
    else reply(res, healthy);
  });
  assert.ok(await waitForRecommender(options) >= 0);
  assert.equal(requests, 3);
  assert.equal(options.child.listenerCount('error'), 0);
});

for (const [name, body] of [['wrong model', { status: 'ok', model_version: 'wrong' }],
  ['wrong health status', { status: 'healthy', model_version: 'v1.0' }]]) {
  test(`does not accept ${name} as readiness`, async t => {
    const options = await fixture(t, (_req, res) => reply(res, body));
    options.startupTimeoutMs = 100;
    await assert.rejects(waitForRecommender(options), /failed to become ready within 100ms/);
    assert.equal(options.child.listenerCount('error'), 0);
  });
}

for (const phase of ['headers', 'body']) {
  test(`a hanging health response (${phase}) cannot bypass the total startup deadline`, async t => {
    const options = await fixture(t, (_req, res) => {
      if (phase === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); }
    });
    options.startupTimeoutMs = 100;
    const started = performance.now();
    await assert.rejects(waitForRecommender(options), /failed to become ready within 100ms/);
    assert.ok(performance.now() - started < 1500, 'Hanging probes must abort, not wait indefinitely');
  });
}

test('child process exit fails early instead of waiting for the startup deadline', async t => {
  const options = await fixture(t, (_req, res) => { options.child.exitCode = 1; res.writeHead(503); res.end(); });
  options.startupTimeoutMs = 10000;
  const started = performance.now();
  await assert.rejects(waitForRecommender(options), /exited before becoming ready/);
  assert.ok(performance.now() - started < 1500);
});

test('spawn failure is handled and never mistaken for healthy unrelated HTTP service', async t => {
  const options = await fixture(t, (_req, res) => {
    options.child.emit('error', new Error('fixture spawn failure'));
    reply(res, healthy);
  });
  options.startupTimeoutMs = 10000;
  const started = performance.now();
  await assert.rejects(waitForRecommender(options), /could not be started/);
  assert.ok(performance.now() - started < 1500);
});
