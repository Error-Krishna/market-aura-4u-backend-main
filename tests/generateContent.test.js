// Intercept module loading for zero-dependency hermetic isolation
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

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const { generateContent } = require('../src/controllers/content/generateContent');

describe('generateContent Controller Integration & Resiliency Suite', () => {
  let origUserFindById;
  let origJobSave;
  let origJobFindByIdAndUpdate;
  let origFetch;
  let origGroqKey;

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
      user: { id: 'usr_mock_123' },
      body: { prompt: 'Launch our sustainable summer skincare collection' },
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

  const completeUser = {
    _id: 'usr_mock_123',
    brandProfile: {
      companyName: 'Lumiere Cosmetics',
      industry: 'Beauty & Cosmetics',
      uvp: 'Sustainable vegan skincare formulated with clinically-backed botanical actives',
      targetAudience: 'Eco-conscious skincare consumers aged 22-38',
      brandVoice: { tone: 'Empowering & Educational', description: 'Be authentic.' },
      platforms: ['twitter', 'instagram'],
    },
  };

  const sampleRecommendation = {
    brand_name: 'Lumiere Cosmetics',
    recommended_topic: 'Clean Beauty Formulations',
    recommended_format: 'Carousel',
    recommended_posting_time: {
      day: 'Wednesday',
      hour_utc: 14,
      utc: 'Wednesday 14:00 UTC',
    },
    trending_topics: [
      { topic: 'cleanbeauty', engagement_lift: 1.34 },
      { topic: 'veganskincare', engagement_lift: 1.18 },
    ],
    engagement_prediction: {
      predicted_likes: 342,
      predicted_shares: 48,
    },
  };

  const mockGroqResponse = {
    twitter: [
      {
        text: 'Clean beauty that truly works. Formulated with botanicals, backed by science. #cleanbeauty #veganskincare',
        image_url: 'PLACEHOLDER_IMAGE',
      },
    ],
    instagram: {
      caption: 'Meet your new daily ritual: clean, potent, plant-derived skincare for glowing results ✨🌿',
      image_url: 'PLACEHOLDER_IMAGE',
    },
  };

  test('Scenario 1: Complete brand profile + healthy recommender -> grounded generation & prompt enrichment', async () => {
    let recommenderCalled = false;
    let recommenderSentPayload = null;
    let groqCalled = false;
    let groqSystemPrompt = null;
    let groqRequestBody = null;

    User.findById = async () => completeUser;
    Job.prototype.save = async function () {
      this._id = 'job_rec_ok_001';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => ({
      _id,
      userId: completeUser._id,
      status: update.status,
      generatedContent: update.generatedContent,
      completedAt: update.completedAt,
    });

    globalThis.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('recommend')) {
        recommenderCalled = true;
        recommenderSentPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            recommendation: sampleRecommendation,
          }),
        };
      }

      if (typeof url === 'string' && url.includes('groq.com')) {
        groqCalled = true;
        const parsedBody = JSON.parse(options.body);
        groqRequestBody = parsedBody;
        groqSystemPrompt = parsedBody.messages.find((m) => m.role === 'system')?.content;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(mockGroqResponse) } }],
          }),
        };
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    assert.strictEqual(res.getStatusCode(), 200);
    assert.strictEqual(res.getBody().success, true);
    assert.strictEqual(recommenderCalled, true);
    assert.strictEqual(groqCalled, true);
    assert.equal(groqRequestBody.n, 1, 'Groq is asked for exactly one completion');
    assert.equal(groqRequestBody.max_completion_tokens, 1536, 'Groq output is bounded by the default token cap');

    // Verify exact contract adherence for payload sent to Python
    assert.strictEqual(recommenderSentPayload.brand_name, 'Lumiere Cosmetics');
    assert.strictEqual(recommenderSentPayload.industry, 'Beauty & Cosmetics');
    assert.strictEqual(recommenderSentPayload.business_description, completeUser.brandProfile.uvp);
    assert.strictEqual(recommenderSentPayload.target_audience, completeUser.brandProfile.targetAudience);
    assert.strictEqual(recommenderSentPayload.brand_tone, 'Empowering & Educational');
    assert.strictEqual(recommenderSentPayload.follower_count, undefined); // Omitted for empirical creator fallback

    // Verify system prompt enrichment
    assert.ok(groqSystemPrompt.includes('--- 1.5. DATA-BACKED RECOMMENDATION SIGNALS ---'));
    assert.ok(groqSystemPrompt.includes('Clean Beauty Formulations'));
    assert.ok(groqSystemPrompt.includes('Carousel'));
    assert.ok(!groqSystemPrompt.includes('#cleanbeauty'));
    assert.ok(!groqSystemPrompt.includes('#veganskincare'));
    assert.ok(groqSystemPrompt.includes('Use only hashtags directly relevant to the user brief and brand.'));

    // Verify grounded response payload
    const job = res.getBody().job;
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.generatedContent.grounding.isGrounded, true);
    assert.deepStrictEqual(job.generatedContent.grounding.recommendation, sampleRecommendation);
    assert.ok(job.generatedContent.twitter[0].text.length > 10);
    assert.ok(job.generatedContent.imageUrl.includes('loremflickr.com'));
  });

  test('Scenario 2: Incomplete brand profile -> 400 Bad Request, no recommender or Groq call', async () => {
    let recommenderCalled = false;
    let groqCalled = false;
    let jobSaved = false;

    // Missing UVP and industry
    const incompleteUser = {
      _id: 'usr_incomplete_002',
      brandProfile: {
        companyName: 'Lumiere Cosmetics',
        industry: '',
        uvp: '',
        targetAudience: 'Everyone',
      },
    };

    User.findById = async () => incompleteUser;
    Job.prototype.save = async function () {
      jobSaved = true;
      return this;
    };
    globalThis.fetch = async (url) => {
      if (url.includes('recommend')) recommenderCalled = true;
      if (url.includes('groq.com')) groqCalled = true;
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    assert.strictEqual(res.getStatusCode(), 400);
    assert.strictEqual(res.getBody().success, false);
    assert.ok(res.getBody().message.includes('Incomplete brand profile'));
    assert.strictEqual(recommenderCalled, false);
    assert.strictEqual(groqCalled, false);
    assert.strictEqual(jobSaved, false);
  });

  test('Scenario 3: Recommender service unavailable (ECONNREFUSED) -> graceful ungrounded fallback', async () => {
    let recommenderCalled = false;
    let groqCalled = false;
    let groqSystemPrompt = null;

    User.findById = async () => completeUser;
    Job.prototype.save = async function () {
      this._id = 'job_unavail_003';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => ({
      _id,
      status: update.status,
      generatedContent: update.generatedContent,
    });

    globalThis.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('recommend')) {
        recommenderCalled = true;
        const err = new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8001');
        throw err;
      }

      if (typeof url === 'string' && url.includes('groq.com')) {
        groqCalled = true;
        const parsedBody = JSON.parse(options.body);
        groqSystemPrompt = parsedBody.messages.find((m) => m.role === 'system')?.content;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(mockGroqResponse) } }],
          }),
        };
      }
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    assert.strictEqual(res.getStatusCode(), 200);
    assert.strictEqual(res.getBody().success, true);
    assert.strictEqual(recommenderCalled, true);
    assert.strictEqual(groqCalled, true);

    // Verify ungrounded prompt and payload
    assert.ok(!groqSystemPrompt.includes('--- 1.5. DATA-BACKED RECOMMENDATION SIGNALS ---'));
    const job = res.getBody().job;
    assert.strictEqual(job.generatedContent.grounding.isGrounded, false);
    assert.strictEqual(job.generatedContent.grounding.recommendation, null);
    assert.ok(job.generatedContent.grounding.reason.includes('unavailable'));
  });

  test('Scenario 4: Recommender request timeout (TimeoutError) -> graceful ungrounded fallback', async () => {
    let recommenderCalled = false;
    let groqCalled = false;

    User.findById = async () => completeUser;
    Job.prototype.save = async function () {
      this._id = 'job_timeout_004';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => ({
      _id,
      status: update.status,
      generatedContent: update.generatedContent,
    });

    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('recommend')) {
        recommenderCalled = true;
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockGroqResponse) } }],
        }),
      };
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    assert.strictEqual(res.getStatusCode(), 200);
    assert.strictEqual(recommenderCalled, true);

    const job = res.getBody().job;
    assert.strictEqual(job.generatedContent.grounding.isGrounded, false);
    assert.strictEqual(job.generatedContent.grounding.recommendation, null);
    assert.ok(job.generatedContent.grounding.reason.includes('timed out'));
  });

  test('Scenario 5: Malformed recommendation response -> graceful ungrounded fallback', async () => {
    User.findById = async () => completeUser;
    Job.prototype.save = async function () {
      this._id = 'job_malformed_005';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => ({
      _id,
      status: update.status,
      generatedContent: update.generatedContent,
    });

    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('recommend')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: false, error: 'Internal failure' }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockGroqResponse) } }],
        }),
      };
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    assert.strictEqual(res.getStatusCode(), 200);
    const job = res.getBody().job;
    assert.strictEqual(job.generatedContent.grounding.isGrounded, false);
    assert.strictEqual(job.generatedContent.grounding.recommendation, null);
    assert.ok(job.generatedContent.grounding.reason.includes('Malformed recommendation'));
  });

  test('Scenario 6: Groq failure -> 500 Internal Server Error & job status updated to failed', async () => {
    let failedJobUpdated = false;

    User.findById = async () => completeUser;
    Job.prototype.save = async function () {
      this._id = 'job_groq_fail_006';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => {
      if (update.status === 'failed') {
        failedJobUpdated = true;
      }
      return { _id, ...update };
    };

    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('recommend')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, recommendation: sampleRecommendation }),
        };
      }

      return {
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      };
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    assert.strictEqual(res.getStatusCode(), 500);
    assert.strictEqual(res.getBody().success, false);
    assert.strictEqual(res.getBody().code, 'GENERATION_FAILED');
    assert.strictEqual(res.getBody().error, 'Generation failed');
    assert.strictEqual(failedJobUpdated, true);
  });

  test('Scenario 7: Backward compatibility -> all platform payload structures preserved', async () => {
    User.findById = async () => completeUser;
    Job.prototype.save = async function () {
      this._id = 'job_compat_007';
      return this;
    };
    Job.findByIdAndUpdate = async (_id, update) => ({
      _id,
      status: update.status,
      generatedContent: update.generatedContent,
    });

    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('recommend')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, recommendation: sampleRecommendation }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockGroqResponse) } }],
        }),
      };
    };

    const { req, res } = createMockHttp();
    await generateContent(req, res);

    const generated = res.getBody().job.generatedContent;
    assert.ok(Array.isArray(generated.twitter));
    assert.strictEqual(typeof generated.twitter[0].text, 'string');
    assert.ok(generated.twitter[0].image_url.startsWith('https://loremflickr.com'));
    assert.ok(typeof generated.instagram.caption, 'string');
    assert.ok(generated.instagram.image_url.startsWith('https://loremflickr.com'));
    assert.ok(generated.imageUrl.startsWith('https://loremflickr.com'));
    assert.ok(generated.grounding !== undefined);
  });
});
