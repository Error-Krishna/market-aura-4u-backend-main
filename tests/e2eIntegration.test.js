// Zero-dependency hermetic module interceptor for User and Job models
const Module = require('module');
const origRequire = Module.prototype.require;

class MockSchema {
  constructor() {}
}
MockSchema.Types = {
  ObjectId: String,
  Mixed: Object,
};

const mockMongoose = {
  Schema: MockSchema,
  model: (name) => {
    class MockModel {
      constructor(data) {
        Object.assign(this, data);
        this._id = 'mock_job_' + Math.random().toString(36).substring(7);
      }
      async save() {
        return this;
      }
      static async findById() {
        return null;
      }
      static async findByIdAndUpdate(_id, update) {
        return { _id, ...update };
      }
    }
    MockModel.modelName = name;
    return MockModel;
  },
  models: {},
};

Module.prototype.require = function (id) {
  if (id === 'mongoose') return mockMongoose;
  return origRequire.apply(this, arguments);
};

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const { generateContent } = require('../src/controllers/content/generateContent');

const PYTHON_EXECUTABLE = path.resolve(__dirname, '../../code/paper/.venv/Scripts/python.exe');
const PYTHON_SERVE_SCRIPT = path.resolve(__dirname, '../../code/paper/src/serve.py');
const PYTHON_CWD = path.resolve(__dirname, '../../code/paper');
const TEST_PORT = 8001;

describe('End-to-End Node.js <-> Python Live Recommendation Integration', () => {
  let pythonProc = null;
  let origUserFindById;
  let origJobSave;
  let origJobFindByIdAndUpdate;
  let origFetch;
  let origGroqKey;

  before(async () => {
    // 1. Spawn live Python recommender daemon
    console.log(`[E2E] Spawning Python daemon on port ${TEST_PORT}...`);
    pythonProc = spawn(PYTHON_EXECUTABLE, [PYTHON_SERVE_SCRIPT, '--port', String(TEST_PORT)], {
      cwd: PYTHON_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    pythonProc.stdout.on('data', (d) => process.stdout.write(`[Python stdout] ${d}`));
    pythonProc.stderr.on('data', (d) => process.stderr.write(`[Python stderr] ${d}`));

    // 2. Poll health check until ready (cold-boot SentenceTransformers initialization)
    const start = Date.now();
    let isReady = false;
    while (Date.now() - start < 25000) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
        if (res.ok) {
          const body = await res.json();
          if (body.status === 'ok' || body.status === 'healthy') {
            isReady = true;
            console.log(`[E2E] Python daemon is healthy and ready (boot time: ${Date.now() - start}ms)`);
            break;
          }
        }
      } catch {
        // Wait for server to bind
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!isReady) {
      if (pythonProc) pythonProc.kill();
      throw new Error('[E2E] Python daemon failed to become ready within 25 seconds.');
    }
  });

  after(() => {
    if (pythonProc) {
      console.log('[E2E] Terminating Python daemon...');
      pythonProc.kill();
    }
  });

  beforeEach(() => {
    origUserFindById = User.findById;
    origJobSave = Job.prototype.save;
    origJobFindByIdAndUpdate = Job.findByIdAndUpdate;
    origFetch = globalThis.fetch;
    origGroqKey = process.env.GROQ_API_KEY;

    // Detect if live GROQ_API_KEY exists without printing or exposing its value
    const hasLiveGroqKey = Boolean(process.env.GROQ_API_KEY);
    if (!hasLiveGroqKey) {
      process.env.GROQ_API_KEY = 'mock_groq_key_for_isolated_testing';
    }
  });

  afterEach(() => {
    User.findById = origUserFindById;
    Job.prototype.save = origJobSave;
    Job.findByIdAndUpdate = origJobFindByIdAndUpdate;
    globalThis.fetch = origFetch;
    process.env.GROQ_API_KEY = origGroqKey;
  });

  function createMockHttp(reqOverrides = {}) {
    const req = {
      user: { id: 'usr_e2e_101' },
      body: { prompt: 'Announce our organic spring rose hydrating toner' },
      ...reqOverrides,
    };

    let statusCode = null;
    let jsonBody = null;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        jsonBody = body;
        return this;
      },
      getStatusCode: () => statusCode,
      getBody: () => jsonBody,
    };

    return { req, res };
  }

  const lumiereUser = {
    _id: 'usr_e2e_101',
    brandProfile: {
      companyName: 'Lumiere Cosmetics',
      industry: 'Beauty & Cosmetics',
      uvp: 'Sustainable vegan skincare formulated with clinically-backed botanical actives',
      targetAudience: 'Eco-conscious skincare consumers aged 22-38',
      brandVoice: { tone: 'Empowering & Educational', description: 'Be authentic.' },
      platforms: ['twitter', 'instagram'],
    },
  };

  const mockGroqPayload = {
    twitter: [
      {
        text: 'Nourish your glow naturally. Powered by pure botanicals. #cleanbeauty #veganskincare',
        image_url: 'PLACEHOLDER_IMAGE',
      },
    ],
    instagram: {
      caption: 'Pure botanical hydration has arrived. Clean, kind, and radiant ✨🌸',
      image_url: 'PLACEHOLDER_IMAGE',
    },
  };

  test('E2E Live: Real Python daemon generates recommendation -> Node injects into Groq prompt & response', async () => {
    User.findById = async () => lumiereUser;
    Job.prototype.save = async function () {
      this._id = 'job_e2e_live_01';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => ({
      _id,
      userId: lumiereUser._id,
      status: update.status,
      generatedContent: update.generatedContent,
      completedAt: update.completedAt,
    });

    let interceptedGroqSystemPrompt = null;
    const realFetch = origFetch;

    globalThis.fetch = async (url, options) => {
      // Direct local recommender requests to real network fetch
      if (typeof url === 'string' && url.includes('127.0.0.1:8001')) {
        return realFetch(url, options);
      }

      // Mock Groq chat completions
      if (typeof url === 'string' && url.includes('groq.com')) {
        const body = JSON.parse(options.body);
        interceptedGroqSystemPrompt = body.messages.find((m) => m.role === 'system')?.content;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(mockGroqPayload) } }],
          }),
        };
      }

      return realFetch(url, options);
    };

    const { req, res } = createMockHttp();
    const startTime = Date.now();
    await generateContent(req, res);
    const durationMs = Date.now() - startTime;

    assert.strictEqual(res.getStatusCode(), 200);
    const body = res.getBody();
    assert.strictEqual(body.success, true);

    const job = body.job;
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.generatedContent.grounding.isGrounded, true);

    const rec = job.generatedContent.grounding.recommendation;
    assert.ok(rec, 'Recommendation object must be present');
    assert.ok(typeof rec.recommended_topic === 'string' && rec.recommended_topic.length > 0);
    assert.ok(rec.recommended_content_type?.value, 'Must specify recommended content type');
    assert.ok(rec.recommended_posting_time?.day, 'Must specify recommended posting day');
    assert.ok(Array.isArray(rec.trending_topics) && rec.trending_topics.length > 0);
    assert.ok(Array.isArray(rec.recommended_hashtags) && rec.recommended_hashtags.length > 0);
    assert.ok(rec.predicted_engagement.value > 0, 'Predicted engagement rate must be positive');

    // Verify system prompt enrichment
    assert.ok(interceptedGroqSystemPrompt.includes('--- 1.5. DATA-BACKED RECOMMENDATION SIGNALS ---'));
    assert.ok(interceptedGroqSystemPrompt.includes(rec.recommended_topic));
    assert.ok(interceptedGroqSystemPrompt.includes(rec.recommended_content_type.value));

    // Verify backward-compatible platform structures
    assert.ok(Array.isArray(job.generatedContent.twitter));
    assert.ok(job.generatedContent.instagram);
    assert.ok(job.generatedContent.imageUrl.includes('loremflickr.com'));

    console.log(`[E2E] Live recommendation inference + Node handling finished in ${durationMs}ms`);
  });
});
