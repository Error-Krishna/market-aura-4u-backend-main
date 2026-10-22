const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Job = require('../src/models/Job');

const backendRoot = path.resolve(__dirname, '..');
const pythonRoot = path.resolve(backendRoot, '..', 'code', 'paper');
const pythonExecutable = path.join(pythonRoot, '.venv', 'Scripts', 'python.exe');
const mongodExecutable = process.env.MONGOD_BIN
  || 'C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe';

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startProcess(command, args, options) {
  const child = spawn(command, args, options);
  child.output = '';
  child.stdout?.on('data', (chunk) => { child.output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { child.output += chunk.toString(); });
  return child;
}

async function waitFor(check, child, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early (${child.exitCode}): ${child.output.slice(-5000)}`);
    }
    try {
      if (await check()) return;
    } catch { /* The service may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${child.output.slice(-5000)}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function apiRequest(port, route, { method = 'GET', token, body } = {}) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(serialized === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(serialized),
        }),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(serialized);
  });
}

test('register → login → onboard → generate → persist → retrieve history with isolated real services', {
  timeout: 360000,
}, async () => {
  assert.ok(fs.existsSync(mongodExecutable), 'Set MONGOD_BIN to a local mongod executable');
  assert.ok(fs.existsSync(pythonExecutable), 'Python recommender virtual environment is required');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'market-aura-isolated-mvp-'));
  const mongoPath = path.join(temporaryRoot, 'mongo-data');
  fs.mkdirSync(mongoPath);
  const mongoLog = path.join(temporaryRoot, 'mongod.log');
  const interceptLog = path.join(temporaryRoot, 'provider-intercepts.json');
  const shimPath = path.join(temporaryRoot, 'safe-fetch-shim.cjs');
  const mongoPort = await freePort();
  const pythonPort = await freePort();
  const apiPort = await freePort();
  const databaseName = `market_aura_test_${process.pid}_${Date.now()}`;
  const mongoUri = `mongodb://127.0.0.1:${mongoPort}/${databaseName}?serverSelectionTimeoutMS=2000`;
  let mongoProcess;
  let pythonProcess;
  let apiProcess;
  let failureApiProcess;
  let mongoConnected = false;
  let mongoStopped = false;

  try {
    fs.writeFileSync(shimPath, `
      const fs = require('node:fs');
      const originalFetch = globalThis.fetch;
      const metrics = { recommendationCalls: 0, groqCalls: 0, groqRequest: null, blockedUrls: [] };
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.origin === process.env.MVP_LOCAL_RECOMMENDER_ORIGIN && url.pathname === '/recommend') {
          metrics.recommendationCalls += 1;
          return originalFetch(input, options);
        }
        if (url.href === 'https://api.groq.com/openai/v1/chat/completions') {
          metrics.groqCalls += 1;
          metrics.groqRequest = JSON.parse(options.body);
          fs.writeFileSync(process.env.MVP_INTERCEPT_LOG, JSON.stringify(metrics));
          const content = {
            twitter: [{ text: 'A simple routine makes clean skincare easier. #skincare', image_url: 'PLACEHOLDER_IMAGE' }],
            instagram: {
              caption: 'Build a thoughtful skincare routine. Swipe for three practical steps.',
              content_type: 'carousel',
              slides: [
                { slide_number: 1, headline: 'Start simple', body: 'Choose a gentle cleanser.' },
                { slide_number: 2, headline: 'Add hydration', body: 'Use a moisturizer that suits your skin.' },
                { slide_number: 3, headline: 'Stay consistent', body: 'Apply sunscreen each morning.' }
              ]
            }
          };
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          });
        }
        metrics.blockedUrls.push(url.origin);
        fs.writeFileSync(process.env.MVP_INTERCEPT_LOG, JSON.stringify(metrics));
        throw new Error('Integration test blocked an outbound HTTP request');
      };
    `);

    mongoProcess = startProcess(mongodExecutable, [
      '--dbpath', mongoPath,
      '--port', String(mongoPort),
      '--bind_ip', '127.0.0.1',
      '--logpath', mongoLog,
      '--quiet',
    ], { cwd: temporaryRoot, stdio: 'ignore', windowsHide: true });

    await waitFor(async () => {
      const probe = await mongoose.createConnection(mongoUri, { serverSelectionTimeoutMS: 300 })
        .asPromise();
      await probe.close();
      return true;
    }, mongoProcess, 'isolated MongoDB', 30000);

    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 3000 });
    mongoConnected = true;
    await Job.createCollection();
    const indexes = await Job.collection.indexes();
    assert.equal(indexes.some((index) => JSON.stringify(Object.entries(index.key))
      === JSON.stringify([['userId', 1], ['createdAt', -1], ['_id', -1]])), false,
      'the proposed compound index must be absent from the fresh isolated database');

    const pythonEnv = {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      TOKENIZERS_PARALLELISM: 'false',
      DATABASE_URL: '',
    };
    pythonProcess = startProcess(pythonExecutable, [
      path.join(pythonRoot, 'src', 'serve.py'), '--host', '127.0.0.1', '--port', String(pythonPort),
    ], { cwd: pythonRoot, env: pythonEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${pythonPort}/health`);
      return response.ok && (await response.json()).status === 'ok';
    }, pythonProcess, 'offline Python recommender');

    const apiEnv = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(apiPort),
      MONGO_URI: mongoUri,
      JWT_SECREAT_KEY: `isolated-test-${require('node:crypto').randomBytes(24).toString('hex')}`,
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      GROQ_API_KEY: 'test-only-intercepted-key',
      GROQ_MODEL: 'openai/gpt-oss-20b',
      GROQ_MAX_OUTPUT_TOKENS: '1536',
      RECOMMENDER_URL: `http://127.0.0.1:${pythonPort}/recommend`,
      RECOMMENDER_HEALTH_URL: `http://127.0.0.1:${pythonPort}/health`,
      RECOMMENDER_TIMEOUT_MS: '30000',
      MVP_LOCAL_RECOMMENDER_ORIGIN: `http://127.0.0.1:${pythonPort}`,
      MVP_INTERCEPT_LOG: interceptLog,
      AUTH_WINDOW_MS: '60000',
      AUTH_MAX_IP_ATTEMPTS: '20',
      AUTH_MAX_ACCOUNT_ATTEMPTS: '10',
      AUTH_MAX_CONCURRENT: '20',
      AUTH_MAX_TRACKED_KEYS: '500',
    };
    apiProcess = startProcess(process.execPath, [
      '--require', shimPath, 'src/app.js',
    ], { cwd: backendRoot, env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${apiPort}/ready`)).status === 200,
      apiProcess, 'Node API with connected MongoDB', 30000);

    const email = `mvp-${process.pid}-${Date.now()}@example.invalid`;
    const password = 'Integration-Test-Password-2026!';
    const registered = await apiRequest(apiPort, '/api/v1/auth/signup', {
      method: 'POST', body: { email, password },
    });
    assert.equal(registered.status, 201);
    assert.ok(registered.body.token);

    const loggedIn = await apiRequest(apiPort, '/api/v1/auth/login', {
      method: 'POST', body: { email, password },
    });
    assert.equal(loggedIn.status, 200);
    const token = loggedIn.body.token;

    const onboarding = await apiRequest(apiPort, '/api/v1/auth/onboarding', {
      method: 'POST', token, body: {
        companyName: 'Isolated Test Skincare',
        industry: 'beauty',
        brandTone: 'helpful and clear',
        uvp: 'Simple skincare made with thoughtful ingredients.',
        targetAudience: 'Adults looking for a straightforward skincare routine.',
        platforms: ['twitter', 'instagram'],
      },
    });
    assert.equal(onboarding.status, 200);
    assert.equal(onboarding.body.user.onboardingCompleted, true);

    const generated = await apiRequest(apiPort, '/api/v1/content/generate', {
      method: 'POST', token,
      body: { prompt: 'Create a practical carousel about a simple skincare routine' },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.equal(generated.body.job.status, 'completed');
    assert.equal(generated.body.job.generatedContent.grounding.isGrounded, true);
    assert.ok(generated.body.job.generatedContent.grounding.recommendation.recommended_topic);
    assert.equal(generated.body.job.generatedContent.instagram.slides.length, 3);

    const persisted = await Job.findById(generated.body.job.id).lean();
    assert.equal(persisted.userId.toString(), registered.body.data.id.toString());
    assert.equal(persisted.status, 'completed');

    const secondEmail = `other-${process.pid}-${Date.now()}@example.invalid`;
    const secondSignup = await apiRequest(apiPort, '/api/v1/auth/signup', {
      method: 'POST', body: { email: secondEmail, password },
    });
    assert.equal(secondSignup.status, 201);
    const otherUserId = new mongoose.Types.ObjectId(secondSignup.body.data.id);
    const ownerId = new mongoose.Types.ObjectId(registered.body.data.id);
    const otherUserJob = await new Job({
      userId: otherUserId, status: 'completed', originalContent: 'PRIVATE OTHER USER CONTENT',
    }).save();
    for (let index = 0; index < 20; index += 1) {
      await new Job({
        userId: ownerId,
        status: 'completed',
        platforms: ['twitter'],
        originalContent: `Isolated pagination fixture ${index}`,
        createdAt: new Date(Date.now() - (index + 1) * 1000),
      }).save();
    }

    const unauthorized = await apiRequest(apiPort, '/api/v1/content/history');
    assert.equal(unauthorized.status, 401);
    const invalidLimit = await apiRequest(apiPort, '/api/v1/content/history?limit=51', { token });
    assert.equal(invalidLimit.status, 400);
    assert.equal(invalidLimit.body.code, 'INVALID_HISTORY_PAGINATION');
    const foreignCursor = await apiRequest(apiPort,
      `/api/v1/content/history?cursor=${otherUserJob._id}`, { token });
    assert.equal(foreignCursor.status, 400);
    assert.equal(foreignCursor.body.code, 'INVALID_HISTORY_PAGINATION');

    const firstPage = await apiRequest(apiPort, '/api/v1/content/history?limit=20', { token });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.count, 21);
    assert.equal(firstPage.body.jobs.length, 20);
    assert.equal(firstPage.body.pagination.hasMore, true);
    assert.equal(JSON.stringify(firstPage.body).includes('PRIVATE OTHER USER CONTENT'), false);

    const nextCursor = encodeURIComponent(firstPage.body.pagination.nextCursor);
    const secondPage = await apiRequest(apiPort, `/api/v1/content/history?limit=20&cursor=${nextCursor}`, { token });
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.jobs.length, 1);
    assert.equal(secondPage.body.pagination.hasMore, false);
    assert.equal(firstPage.body.jobs.some((job) => secondPage.body.jobs.some((next) => next.id === job.id)), false);

    const metrics = JSON.parse(fs.readFileSync(interceptLog, 'utf8'));
    assert.equal(metrics.recommendationCalls, 1, 'one real request reached the local Python service');
    assert.equal(metrics.groqCalls, 1, 'the only Groq endpoint request was intercepted locally');
    assert.equal(metrics.groqRequest.model, 'openai/gpt-oss-20b');
    assert.equal(metrics.groqRequest.max_completion_tokens, 1536);
    assert.deepEqual(metrics.blockedUrls, [], 'no other outbound HTTP calls were attempted');

    const unavailableMongoPort = await freePort();
    const unavailableApiPort = await freePort();
    const unavailableApiEnv = {
      ...apiEnv,
      PORT: String(unavailableApiPort),
      MONGO_URI: `mongodb://127.0.0.1:${unavailableMongoPort}/unavailable_test?serverSelectionTimeoutMS=1000`,
    };
    failureApiProcess = startProcess(process.execPath, [
      '--require', shimPath, 'src/app.js',
    ], { cwd: backendRoot, env: unavailableApiEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${unavailableApiPort}/health`);
      return response.ok;
    }, failureApiProcess, 'API liveness without MongoDB', 10000);
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${unavailableApiPort}/ready`);
      return response.status === 503 && failureApiProcess.output.includes('MongoDB connection failed');
    }, failureApiProcess, 'API startup with a failed MongoDB dependency', 15000);
    const unavailableHistory = await apiRequest(unavailableApiPort, '/api/v1/content/history', { token });
    assert.equal(unavailableHistory.status, 503);
    assert.equal(unavailableHistory.body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');

    console.log('Verified isolated Mongo persistence, auth, onboarding, local Python grounding, Groq interception, and owner-scoped cursor history.');
    await stopProcess(mongoProcess);
    mongoStopped = true;
  } finally {
    await stopProcess(failureApiProcess);
    if (mongoConnected && !mongoStopped) {
      try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
    } else if (mongoConnected) {
      await mongoose.disconnect();
    }
    await stopProcess(apiProcess);
    await stopProcess(pythonProcess);
    await stopProcess(mongoProcess);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
