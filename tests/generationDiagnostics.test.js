const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const { generateContent, validateAndNormalizeContent } = require('../src/controllers/content/generateContent');
const { createGenerationDiagnostics } = require('../src/utils/generationDiagnostics');
const { GenerationValidationError } = require('../src/utils/generationValidationError');

const sensitive = 'SENSITIVE_SENTINEL password cookie Bearer credential prompt raw-body';
const content = {
  twitter: [{ text: 'A gentle routine: cleanse, moisturize, protect.' }],
  instagram: { caption: 'Swipe for your routine.', slides: [
    { headline: 'Cleanse', body: 'Use a gentle cleanser.' },
    { headline: 'Moisturize', body: 'Apply a suitable moisturizer.' },
    { headline: 'Protect', body: 'Use sunscreen during the day.' },
  ] },
};
const completion = (text = JSON.stringify(content), reason = 'stop') => ({
  choices: [{ finish_reason: reason, message: { content: text, reasoning: sensitive } }],
  usage: { prompt_tokens: 123, completion_tokens: 456, total_tokens: 579,
    completion_tokens_details: { reasoning_tokens: 100, secret: sensitive }, secret: sensitive },
  error: sensitive, id: sensitive, model: sensitive,
});
afterEach(() => mock.restoreAll());
let sequence = 0;

async function exercise(options = {}) {
  const logs = [];
  const writes = [];
  let providerCalls = 0;
  let cancelled = 0;
  const userId = (1 + sequence++).toString(16).padStart(24, '0');
  const brand = { brandProfile: { companyName: 'Synthetic', industry: 'Skincare', uvp: sensitive,
    targetAudience: 'Beginners', brandVoice: { tone: 'Friendly' }, platforms: options.platforms || ['twitter', 'instagram'] } };
  mock.method(console, 'error', (...args) => logs.push(args));
  mock.method(console, 'log', () => {});
  mock.method(User, 'findById', async () => {
    if (options.userFailure) throw new Error(sensitive);
    return brand;
  });
  mock.method(Job.prototype, 'save', async function () {
    if (options.createFailure) throw new Error(sensitive);
    return this;
  });
  mock.method(Job, 'findByIdAndUpdate', async (id, update) => {
    writes.push(update);
    if (options.completeFailure && update.status === 'completed') throw new Error(sensitive);
    if (options.failureWriteFailure && update.status === 'failed') throw new Error(sensitive);
    return { id, ...update };
  });
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === 'http://localhost:8001/recommend') {
      return { ok: true, json: async () => ({ recommended_topic: 'Routine',
        recommended_content_type: { value: options.promptFailure ? {} : 'carousel' } }) };
    }
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions', 'All external requests must be mocked');
    providerCalls++;
    const request = JSON.parse(init.body);
    assert.equal(request.n, 1);
    assert.equal(request.max_completion_tokens, 1536);
    if (options.transportFailure) throw new Error(sensitive);
    if (options.timeout) throw new DOMException(sensitive, 'TimeoutError');
    return {
      ok: !options.httpStatus, status: options.httpStatus || 200,
      body: { cancel: async () => { cancelled++; } },
      json: async () => {
        assert.equal(options.httpStatus, undefined, 'Non-OK response bodies must not be parsed');
        if (options.bodyFailure) throw new SyntaxError(sensitive);
        if (options.bodyTimeout) throw new DOMException(sensitive, 'TimeoutError');
        return options.data || completion();
      },
    };
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await generateContent({ user: { id: userId }, body: { prompt: 'Create a simple routine carousel' } }, res);
  const records = logs.map(args => {
    assert.equal(args.length, 1, 'Do not pass exception objects as extra console arguments');
    return JSON.parse(args[0]);
  });
  assert.ok(!JSON.stringify(logs).includes(sensitive));
  if (res.statusCode !== 200) {
    assert.ok(!JSON.stringify(res.body).includes(sensitive));
    for (const update of writes.filter(write => write.status === 'failed')) {
      assert.deepEqual(Object.keys(update).sort(), ['error', 'status']);
      assert.ok(['Generation failed', 'Content generation timed out. Please try again later.'].includes(update.error));
    }
  }
  for (const record of records) {
    assert.equal(record.event, 'generation_failure');
    assert.ok(Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0);
    assert.ok(record.jobId === null || /^[a-f\d]{24}$/i.test(record.jobId));
    assert.ok(Object.keys(record).every(key => ['event', 'stage', 'category', 'jobId', 'elapsedMs',
      'providerHttpStatus', 'finishReason', 'usage', 'validationReason', 'validationPlatform'].includes(key)));
  }
  return { res, records, writes, providerCalls, cancelled };
}

for (const status of [400, 401, 403, 429, 500, 503]) {
  test(`HTTP ${status}: safe provider status, no error-body parsing, no retries`, async () => {
    const result = await exercise({ httpStatus: status });
    assert.equal(result.res.statusCode, 500);
    assert.equal(result.res.body.code, 'GENERATION_FAILED');
    assert.equal(result.records[0].category, 'PROVIDER_HTTP_ERROR');
    assert.equal(result.records[0].providerHttpStatus, status);
    assert.equal(result.providerCalls, 1);
    assert.equal(result.cancelled, 1);
  });
}

for (const [name, options, category, stage] of [
  ['transport', { transportFailure: true }, 'PROVIDER_TRANSPORT_ERROR', 'provider_request'],
  ['body', { bodyFailure: true }, 'PROVIDER_BODY_ERROR', 'provider_body'],
  ['fetch timeout', { timeout: true }, 'PROVIDER_TIMEOUT', 'provider_request'],
  ['body timeout', { bodyTimeout: true }, 'PROVIDER_TIMEOUT', 'provider_body'],
  ['empty output', { data: { choices: [] } }, 'OUTPUT_EMPTY', 'output_empty'],
  ['truncated output', { data: completion(JSON.stringify(content), 'length') }, 'OUTPUT_TRUNCATED', 'output_truncated'],
  ['invalid JSON', { data: completion(sensitive) }, 'OUTPUT_PARSE_ERROR', 'output_parse'],
  ['invalid platform shape', { data: completion(JSON.stringify({ twitter: [{ text: sensitive }] })) }, 'OUTPUT_VALIDATION_ERROR', 'output_validation'],
  ['completion write', { completeFailure: true }, 'JOB_COMPLETE_FAILED', 'job_complete'],
  ['user lookup', { userFailure: true }, 'USER_LOOKUP_FAILED', 'user_lookup'],
  ['job creation', { createFailure: true }, 'JOB_CREATE_FAILED', 'job_create'],
  ['prompt preparation', { promptFailure: true }, 'PROMPT_PREPARATION_FAILED', 'prompt_preparation'],
]) {
  test(`${name}: distinguish failure stage without leaking diagnostics into public or saved errors`, async () => {
    const result = await exercise(options);
    assert.equal(result.res.statusCode, options.timeout || options.bodyTimeout ? 504 : 500);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].category, category);
    assert.equal(result.records[0].stage, stage);
    assert.equal(result.providerCalls, options.userFailure || options.createFailure || options.promptFailure ? 0 : 1);
    if (options.completeFailure || stage === 'output_truncated') {
      assert.deepEqual(result.records[0].usage, { prompt_tokens: 123, completion_tokens: 456, total_tokens: 579, reasoning_tokens: 100 });
      assert.equal(result.records[0].finishReason, stage === 'output_truncated' ? 'length' : 'stop');
      assert.equal(result.records[0].providerHttpStatus, 200);
    }
  });
}

test('failure-status write has its own safe category and does not replace the original response', async () => {
  const result = await exercise({ httpStatus: 401, failureWriteFailure: true });
  assert.deepEqual(result.records.map(record => record.category), ['PROVIDER_HTTP_ERROR', 'JOB_FAILURE_SAVE_FAILED']);
  assert.equal(result.records[0].jobId, result.records[1].jobId);
  assert.equal(result.res.statusCode, 500);
  assert.equal(result.res.body.code, 'GENERATION_FAILED');
  assert.equal(result.providerCalls, 1);
});

test('successful generation keeps its existing response and does not emit a failure log', async () => {
  const result = await exercise();
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.job.generatedContent.grounding.isGrounded, true);
  assert.equal(result.res.body.job.generatedContent.instagram.slides.length, 3);
  assert.equal(result.records.length, 0);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.res.body.diagnostics, undefined);
  assert.equal(result.res.body.job.generatedContent.usage, undefined);
});

test('untrusted metadata is reduced to fixed enums and nonnegative integer counts', () => {
  const diagnostics = createGenerationDiagnostics();
  diagnostics.enter(sensitive);
  diagnostics.providerStatus(sensitive);
  diagnostics.completion({ choices: [{ finish_reason: sensitive }], usage: {
    prompt_tokens: sensitive, completion_tokens: -1, total_tokens: Infinity,
    completion_tokens_details: { reasoning_tokens: 1.5 }, secret: sensitive,
  } });
  const record = diagnostics.failure(new Error(sensitive), sensitive);
  assert.equal(record.category, 'GENERATION_UNKNOWN');
  assert.equal(record.stage, 'unknown');
  assert.equal(record.jobId, null);
  assert.equal(record.finishReason, 'other');
  assert.equal(record.providerHttpStatus, undefined);
  assert.equal(record.usage, undefined);
  assert.ok(!JSON.stringify(record).includes(sensitive));
});

for (const [value, platforms, reason, platform] of [
  [[], ['twitter'], 'INVALID_OUTPUT_OBJECT', undefined],
  [{}, ['linkedin'], 'MISSING_PLATFORM', 'linkedin'],
  [{ twitter: sensitive }, ['twitter'], 'INVALID_TWITTER_POSTS', 'twitter'],
  [{ twitter: [{}] }, ['twitter'], 'MISSING_TWITTER_TEXT', 'twitter'],
  [{ twitter: [{ text: sensitive.repeat(20) }] }, ['twitter'], 'TWITTER_TEXT_TOO_LONG', 'twitter'],
  ...['linkedin', 'facebook', 'blog'].map(platform => [
    { [platform]: { body: sensitive } }, [platform], 'INVALID_PLATFORM_POSTS', platform,
  ]),
  [{ email: { subject: sensitive } }, ['email'], 'INVALID_EMAIL', 'email'],
  [{ instagram: sensitive }, ['instagram'], 'INVALID_INSTAGRAM_OBJECT', 'instagram'],
  [{ instagram: { caption: ' ' } }, ['instagram'], 'MISSING_INSTAGRAM_CAPTION', 'instagram'],
  [{ instagram: { caption: sensitive, slides: [] } }, ['instagram'], 'INVALID_CAROUSEL_SLIDES', 'instagram'],
  [{ instagram: { caption: sensitive, slides: [{ headline: sensitive }, 'Two', 'Three'] } },
    ['instagram'], 'INVALID_CAROUSEL_SLIDE_TEXT', 'instagram'],
]) {
  test(`safe validation reason ${reason} for ${platform || 'root'} without content leakage`, () => {
    const diagnostics = createGenerationDiagnostics();
    diagnostics.enter('output_validation');
    let failure;
    try { validateAndNormalizeContent(structuredClone(value), platforms, true); }
    catch (error) { failure = error; }
    assert.ok(failure instanceof GenerationValidationError);
    const record = diagnostics.failure(failure, null);
    assert.equal(record.validationReason, reason);
    assert.equal(record.validationPlatform, platform);
    assert.ok(!JSON.stringify(record).includes(sensitive));
    assert.equal(record.category, 'OUTPUT_VALIDATION_ERROR');
  });
}

test('untrusted error properties cannot inject validation details, even with valid-looking enums', () => {
  const diagnostics = createGenerationDiagnostics();
  diagnostics.enter('output_validation');
  for (const error of [new Error(sensitive), { validationReason: 'MISSING_PLATFORM', validationPlatform: sensitive }]) {
    const record = diagnostics.failure(error, null);
    assert.equal(record.validationReason, undefined);
    assert.equal(record.validationPlatform, undefined);
    assert.ok(!JSON.stringify(record).includes(sensitive));
  }
  const record = diagnostics.failure(new GenerationValidationError(sensitive, sensitive, sensitive), null);
  assert.equal(record.validationReason, 'UNKNOWN_VALIDATION_REASON');
  assert.equal(record.validationPlatform, undefined);
  assert.ok(!JSON.stringify(record).includes(sensitive));
  diagnostics.enter('job_failure_save');
  assert.equal(diagnostics.failure(new GenerationValidationError(sensitive, 'MISSING_PLATFORM', 'twitter'), null).validationReason, undefined);
});

for (const [output, reason, platform] of [
  [{ ...content, linkedin: { body: sensitive } }, 'INVALID_PLATFORM_POSTS', 'linkedin'],
  [{ ...content, linkedin: ['Valid post'], twitter: [{ text: sensitive.repeat(20) }] }, 'TWITTER_TEXT_TOO_LONG', 'twitter'],
  [{ ...content, linkedin: ['Valid post'], instagram: { caption: sensitive, slides: ['One', 'Two'] } }, 'INVALID_CAROUSEL_SLIDES', 'instagram'],
]) {
  test(`three-platform controller rejects ${reason}, logs only enums and makes one provider attempt`, async () => {
    const result = await exercise({ platforms: ['twitter', 'linkedin', 'instagram'], data: completion(JSON.stringify(output)) });
    assert.equal(result.res.statusCode, 500);
    assert.equal(result.providerCalls, 1);
    assert.equal(result.records[0].validationReason, reason);
    assert.equal(result.records[0].validationPlatform, platform);
    assert.equal(result.records[0].providerHttpStatus, 200);
    assert.equal(result.records[0].finishReason, 'stop');
    assert.deepEqual(result.res.body, { success: false, code: 'GENERATION_FAILED', message: 'Generation failed', error: 'Generation failed' });
    assert.deepEqual(result.writes, [{ status: 'failed', error: 'Generation failed' }]);
  });
}

for (const [label, linkedin] of [
  ['string array', ['A useful LinkedIn post.']],
  ['single string', 'A useful LinkedIn post.'],
  ['single text object', { text: 'A useful LinkedIn post.' }],
  ['text-object array', [{ text: 'A useful LinkedIn post.' }]],
]) {
  test(`three-platform ${label} output completes and persists canonical LinkedIn text without retry`, async () => {
    const result = await exercise({ platforms: ['twitter', 'linkedin', 'instagram'],
      data: completion(JSON.stringify({ ...content, linkedin })) });
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.providerCalls, 1);
    assert.equal(result.records.length, 0);
    assert.deepEqual(result.res.body.job.generatedContent.linkedin, ['A useful LinkedIn post.']);
    assert.deepEqual(result.writes[0].generatedContent.linkedin, ['A useful LinkedIn post.']);
    assert.equal(result.writes[0].status, 'completed');
    assert.equal(result.res.body.job.generatedContent.twitter[0].text, content.twitter[0].text);
    assert.equal(result.res.body.job.generatedContent.instagram.slides.length, 3);
    assert.equal(result.res.body.job.generatedContent.grounding.isGrounded, true);
  });
}
