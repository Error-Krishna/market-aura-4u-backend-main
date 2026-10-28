const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const audience = 'https://python-recommender-test.run.app';
const testEnv = {
  RECOMMENDER_URL: `${audience}/recommend`, RECOMMENDER_HEALTH_URL: `${audience}/health`,
  RECOMMENDER_AUTH_MODE: 'cloud-run', RECOMMENDER_AUDIENCE: audience,
  RECOMMENDER_TIMEOUT_MS: '2000', GROQ_API_KEY: 'offline-test-provider-key',
};
const previous = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, testEnv);
after(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const { generateContent } = require('../src/controllers/content/generateContent');
const serviceToken = `e30.${Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.syntheticServiceIdentity`;
const recommendation = { recommended_topic: 'skincare', model_version: 'v1.0' };

for (const scenario of ['healthy', 'metadata denied', 'identity transport failure', 'private service denied', 'identity timeout']) {
  test(`generation with Cloud Run identity: ${scenario}`, async t => {
    const calls = [];
    const warnings = [];
    const updates = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    t.mock.method(User, 'findById', async () => ({
      brandProfile: { companyName: 'Offline brand', industry: 'beauty', uvp: 'Simple care.', targetAudience: 'Adults.', platforms: ['twitter'] },
    }));
    t.mock.method(Job.prototype, 'save', async function () { return this; });
    t.mock.method(Job, 'findByIdAndUpdate', async (_id, update) => { updates.push(update); return { id: String(_id), ...update }; });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push(url);
      if (url.startsWith('http://metadata.google.internal/')) {
        assert.equal(options.headers['Metadata-Flavor'], 'Google');
        if (scenario === 'metadata denied') return new Response(serviceToken, { status: 403 });
        if (scenario === 'identity transport failure') throw new Error(`Sensitive header Bearer ${serviceToken}`);
        if (scenario === 'identity timeout') throw new DOMException(`Sensitive ${serviceToken}`, 'TimeoutError');
        return new Response(serviceToken, { headers: { 'Metadata-Flavor': 'Google' } });
      }
      if (url === testEnv.RECOMMENDER_URL) {
        assert.equal(options.headers.Authorization, `Bearer ${serviceToken}`);
        assert.notEqual(options.headers.Authorization, 'Bearer synthetic-user-session');
        assert.equal(options.redirect, 'error');
        if (scenario === 'private service denied') return new Response(serviceToken, { status: 403 });
        return new Response(JSON.stringify(recommendation));
      }
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions', 'Any unexpected outbound call must fail the test');
      assert.equal(options.headers.Authorization, 'Bearer offline-test-provider-key');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"twitter":[{"text":"A simple routine. #skincare"}]}' } }] }));
    });
    let status;
    let result;
    const response = { status(code) { status = code; return this; }, json(body) { result = body; return this; } };
    await generateContent({ user: { id: new (require('mongoose').Types.ObjectId)().toString() },
      headers: { authorization: 'Bearer synthetic-user-session' }, body: { prompt: 'Create a skincare tip' } }, response);
    assert.equal(status, 200);
    assert.deepEqual(updates.map(update => update.status), ['completed']);
    const grounding = result.job.generatedContent.grounding;
    assert.equal(grounding.isGrounded, scenario === 'healthy');
    if (scenario === 'healthy') assert.deepEqual(grounding.recommendation, recommendation);
    else {
      assert.equal(grounding.recommendation, null);
      assert.match(grounding.reason, scenario === 'private service denied' ? /HTTP 403/ : scenario === 'identity timeout' ? /timed out/ : /authentication unavailable/);
    }
    assert.equal(calls.filter(url => url.startsWith('http://metadata.google.internal/')).length, 1);
    assert.equal(calls.filter(url => url === testEnv.RECOMMENDER_URL).length,
      scenario === 'healthy' || scenario === 'private service denied' ? 1 : 0);
    assert.equal(calls.filter(url => url.includes('api.groq.com')).length, 1);
    assert.equal(JSON.stringify(result).includes(serviceToken), false);
    assert.equal(warnings.join(' ').includes(serviceToken), false);
  });
}
