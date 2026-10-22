const assert = require('node:assert/strict');
const http = require('node:http');
const { before, after, beforeEach, test, mock } = require('node:test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Job = require('../src/models/Job');

const secret = 'test-only-content-history-key';
const ids = ['111111111111111111111111', '222222222222222222222222'];
const envNames = ['NODE_ENV', 'JWT_SECREAT_KEY', 'CORS_ALLOWED_ORIGINS'];
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let server;
let users;
let jobs;
let findFilters;
let findLimits;
let findOneFilters;
let countFilters;
let userReads;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECREAT_KEY = secret;
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
  mock.method(mongoose, 'connect', () => assert.fail('History route must not connect to MongoDB'));
  mock.method(User, 'findOne', async ({ email }) => {
    userReads++;
    return [...users.values()].find(user => user.email === email) ?? null;
  });
  mock.method(User, 'findById', async id => users.get(String(id)) ?? null);
  mock.method(Job, 'findOne', filter => {
    findOneFilters.push(structuredClone(filter));
    const cursorId = String(filter._id);
    const record = jobs.find(job => job.userId === String(filter.userId) && job._id === cursorId);
    return { select: async () => record ? { createdAt: record.createdAt } : null };
  });
  mock.method(Job, 'find', filter => {
    findFilters.push(structuredClone(filter));
    let sortSpec = { createdAt: -1, _id: -1 };
    let resultLimit = Number.POSITIVE_INFINITY;
    const query = {
      sort(spec) { sortSpec = spec; return this; },
      limit(value) { resultLimit = value; findLimits.push(value); return this; },
      then(resolve, reject) {
        try {
          const records = jobs.filter(job => matchesFilter(job, filter));
          records.sort((left, right) => {
            for (const [field, direction] of Object.entries(sortSpec)) {
              const a = field === '_id' ? left[field] : new Date(left[field]).getTime();
              const b = field === '_id' ? right[field] : new Date(right[field]).getTime();
              if (a !== b) return a < b ? -direction : direction;
            }
            return 0;
          });
          return Promise.resolve(records.slice(0, resultLimit)).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return query;
  });
  mock.method(Job, 'countDocuments', async filter => {
    countFilters.push(structuredClone(filter));
    return jobs.filter(job => job.userId === String(filter.userId)).length;
  });
  server = http.createServer(require('../src/app'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

beforeEach(() => {
  userReads = 0;
  findFilters = [];
  findLimits = [];
  findOneFilters = [];
  countFilters = [];
  users = new Map(ids.map((id, index) => [id, {
    _id: id,
    id,
    email: `owner${index}@example.invalid`,
    onboardingCompleted: true,
  }]));
  jobs = ids.flatMap((userId, ownerIndex) => Array.from({ length: 25 }, (_, index) => {
    const id = new mongoose.Types.ObjectId(
      (BigInt(ownerIndex + 1) * 1000n + BigInt(index + 1)).toString(16).padStart(24, '0'),
    ).toString();
    return {
      _id: id,
      id,
      userId,
      status: 'completed',
      platforms: ['instagram'],
      originalContent: `Private prompt ${ownerIndex}-${index}`,
      generatedContent: { instagram: { caption: `Private caption ${ownerIndex}-${index}` } },
      // Equal timestamps exercise the _id tie-break for stable page boundaries.
      createdAt: new Date(Date.UTC(2026, 9, 18 - Math.floor(index / 5))),
      toJSON() {
        const { _id, ...record } = this;
        return { ...record, id: String(_id) };
      },
    };
  }));
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  mock.restoreAll();
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function matchesFilter(job, filter) {
  if (job.userId !== String(filter.userId)) return false;
  if (filter.createdAt === null && job.createdAt != null) return false;
  if (filter.createdAt?.$exists === false && job.createdAt !== undefined) return false;
  if (filter._id?.$lt && !(job._id < String(filter._id.$lt))) return false;
  if (!filter.$or) return true;
  return filter.$or.some(condition => {
    if (condition.createdAt === null) return job.createdAt == null;
    if (condition.createdAt?.$exists === false) return job.createdAt === undefined;
    if (condition.createdAt?.$lt) return job.createdAt < condition.createdAt.$lt;
    return job.createdAt.getTime() === condition.createdAt.getTime() &&
      job._id < String(condition._id.$lt);
  });
}

function request({ authenticated = true, account = 0, query = '' } = {}) {
  const token = jwt.sign({ id: ids[account], email: `owner${account}@example.invalid` }, secret);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: `/api/v1/content/history${query ? `?${query}` : ''}`,
      headers: {
        Origin: 'http://localhost:5173',
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data,
      }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Local history request timed out')));
    req.end();
  });
}

test('history route requires authentication before reading users or jobs', async () => {
  const response = await request({ authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(userReads, 0);
  assert.deepEqual(findFilters, []);
  assert.deepEqual(countFilters, []);
});

test('default pagination returns at most 20 newest jobs and preserves total count', async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.count, 25);
  assert.equal(response.body.jobs.length, 20);
  assert.deepEqual(response.body.pagination, {
    limit: 20,
    hasMore: true,
    nextCursor: response.body.jobs[19].id,
  });
  assert.deepEqual(findFilters, [{ userId: ids[0] }]);
  assert.deepEqual(countFilters, [{ userId: ids[0] }]);
  assert.deepEqual(findFilters[0], { userId: ids[0] }, 'the job query is owner-scoped');
  assert.deepEqual(findLimits, [21], 'MongoDB fetches one extra row to determine hasMore');
});

test('maximum page size is 50 and returns a cursor when more results remain', async () => {
  for (let index = 25; index < 60; index++) {
    const id = new mongoose.Types.ObjectId((1000n + BigInt(index + 1)).toString(16).padStart(24, '0')).toString();
    jobs.push({
      _id: id,
      id,
      userId: ids[0],
      status: 'completed',
      platforms: ['twitter'],
      originalContent: `Additional prompt ${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 30 - index)),
    });
  }
  const response = await request({ query: 'limit=50' });
  assert.equal(response.status, 200);
  assert.equal(response.body.jobs.length, 50);
  assert.equal(response.body.count, 60);
  assert.equal(response.body.pagination.limit, 50);
  assert.equal(response.body.pagination.hasMore, true);
  assert.equal(response.body.pagination.nextCursor, response.body.jobs[49].id);
  assert.deepEqual(findLimits, [51]);
});

test('cursor pages remain newest-first, stable across tied timestamps, and do not overlap', async () => {
  const first = await request();
  const second = await request({ query: `cursor=${first.body.pagination.nextCursor}` });
  assert.equal(second.status, 200);
  assert.equal(second.body.jobs.length, 5);
  assert.equal(second.body.pagination.hasMore, false);
  const combined = [...first.body.jobs, ...second.body.jobs];
  assert.equal(new Set(combined.map(job => job.id)).size, 25);
  assert.deepEqual(combined.map(job => job.id), jobs
    .filter(job => job.userId === ids[0])
    .sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id))
    .map(job => job.id));
  assert.deepEqual(findFilters[1].userId, ids[0]);
  assert.ok(findFilters[1].$or);
  assert.deepEqual(findOneFilters[0].userId, ids[0]);
  assert.deepEqual(findLimits, [21, 21]);
});

test('invalid limits and unsupported pagination parameters are rejected', async () => {
  for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=1e2',
    'limit=abc', 'limit=20&limit=30', 'page=2', 'offset=20']) {
    const response = await request({ query });
    assert.equal(response.status, 400, query);
    assert.equal(response.body.code, 'INVALID_HISTORY_PAGINATION', query);
  }
  assert.deepEqual(findFilters, []);
});

test('malformed and foreign-user cursors are rejected without exposing records', async () => {
  const malformed = await request({ query: 'cursor=not-an-object-id' });
  assert.equal(malformed.status, 400);
  const foreign = await request({ query: `cursor=${jobs.find(job => job.userId === ids[1])._id}` });
  assert.equal(foreign.status, 400);
  assert.equal(JSON.stringify(foreign.body).includes('Private caption'), false);
  assert.deepEqual(findFilters, []);
  assert.ok(findOneFilters.every(filter => filter.userId === ids[0]));
});

test('empty history retains the existing envelope and returns exhausted pagination metadata', async () => {
  jobs = [];
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.jobs, []);
  assert.equal(response.body.count, 0);
  assert.deepEqual(response.body.pagination, { limit: 20, hasMore: false, nextCursor: null });
});

test('legacy failed-job diagnostics are redacted without modifying stored history', async () => {
  const record = jobs.find(job => job.userId === ids[0]);
  record.status = 'failed';
  record.error = 'PRIVATE_LEGACY_ERROR fixture-credential and private provider response';
  const response = await request();
  assert.equal(response.status, 200);
  const returned = response.body.jobs.find(job => job.id === record.id);
  assert.equal(returned.error, 'Generation failed');
  assert.equal(JSON.stringify(response.body).includes('PRIVATE_LEGACY_ERROR'), false);
  assert.equal(record.error, 'PRIVATE_LEGACY_ERROR fixture-credential and private provider response');
  assert.deepEqual(returned.generatedContent, record.generatedContent);
});

test('history serialization preserves real Mongoose ids, content maps and safe timeout text', () => {
  const { publicHistoryJob } = require('../src/utils/generationFailure');
  const document = new Job({
    userId: ids[0], status: 'failed', error: 'PRIVATE_LEGACY_ERROR',
    generatedContent: { twitter: [{ text: 'Saved caption' }], grounding: { grounded: true } },
  });
  const returned = publicHistoryJob(document);
  assert.equal(returned.id, String(document._id));
  assert.equal(returned._id, undefined);
  assert.deepEqual(returned.generatedContent, {
    twitter: [{ text: 'Saved caption' }], grounding: { grounded: true },
  });
  assert.equal(returned.error, 'Generation failed');
  assert.equal(document.error, 'PRIVATE_LEGACY_ERROR');
  const timeout = 'Content generation timed out. Please try again later.';
  assert.equal(publicHistoryJob({ error: timeout }).error, timeout);
  assert.deepEqual(publicHistoryJob({ id: 'legacy', status: 'completed' }), {
    id: 'legacy', status: 'completed',
  });
});

test('history database failures return a generic error and safe logs', async t => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(Job, 'countDocuments', async () => { throw new Error('PRIVATE_DATABASE_ERROR'); });
  const response = await request();
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { success: false, message: 'Server Error fetching content history' });
  assert.deepEqual(errors, ['Error fetching history']);
});
