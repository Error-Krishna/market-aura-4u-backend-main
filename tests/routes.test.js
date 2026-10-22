const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { Socket } = require('node:net');
const path = require('node:path');
const { test } = require('node:test');

const backendRoot = path.resolve(__dirname, '..');

test('relative source imports match exact filename casing', () => {
  function auditDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        auditDirectory(filename);
      } else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(filename, 'utf8');
        const imports = source.matchAll(/\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g);
        for (const [, , specifier] of imports) {
          const resolved = createRequire(filename).resolve(specifier);
          let parent = backendRoot;
          // Check directory entries explicitly so Windows also catches Linux failures.
          for (const segment of path.relative(backendRoot, resolved).split(path.sep)) {
            assert.ok(
              fs.readdirSync(parent).includes(segment),
              `${path.relative(backendRoot, filename)}: ${specifier} has incorrect casing at ${segment}`,
            );
            parent = path.join(parent, segment);
          }
        }
      }
    }
  }

  auditDirectory(path.join(backendRoot, 'src'));
});

test('production router loads offline and preserves auth route contracts', (t) => {
  const serviceEnv = Object.entries(process.env).filter(([name]) =>
    /^(MONGO_|GROQ_|JWT_|RAZORPAY_|INSTAGRAM_|TWITTER_|RECOMMENDER_)/.test(name),
  );
  for (const [name] of serviceEnv) delete process.env[name];
  t.after(() => {
    for (const [name, value] of serviceEnv) process.env[name] = value;
  });
  const rejectNetwork = () => assert.fail('Route loading must not make network calls');
  t.mock.method(Socket.prototype, 'connect', rejectNetwork);
  t.mock.method(globalThis, 'fetch', rejectNetwork);

  // Load the real router and controllers, without app.js starting a server or DB.
  const apiRouter = require('../src/routes');
  const authRouter = require('../src/routes/v1/auth/authRouter');
  assert.equal(typeof apiRouter, 'function');
  assert.deepEqual(
    authRouter.stack.filter((layer) => layer.route).map(({ route }) => ({
      path: route.path,
      methods: Object.keys(route.methods),
    })),
    [
      { path: '/logout', methods: ['post'] },
      { path: '/signup', methods: ['post'] },
      { path: '/login', methods: ['post'] },
      { path: '/profile', methods: ['get'] },
      { path: '/onboarding', methods: ['post'] },
    ],
  );
  const auth = require('../src/middleware/auth');
  for (const routePath of ['/profile', '/onboarding']) {
    const { route } = authRouter.stack.find((layer) => layer.route?.path === routePath);
    assert.equal(route.stack[0].handle, auth);
  }
});
