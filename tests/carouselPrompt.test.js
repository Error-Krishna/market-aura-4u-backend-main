const assert = require('node:assert/strict');
const { test } = require('node:test');
const { callAIAndGenerateContent } = require('../src/controllers/content/generateContent');

const brand = {
  brandProfile: {
    companyName: 'Demo skincare',
    industry: 'skincare',
    uvp: 'Simple routines for beginners',
    targetAudience: 'Skincare beginners',
  },
};

for (const carousel of [true, false]) {
  test(`generation prompt ${carousel ? 'keeps carousel caption steps aligned with slides' : 'keeps single-image copy unchanged'}`, async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    let systemPrompt;
    try {
      globalThis.fetch = async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        systemPrompt = request.messages.find(message => message.role === 'system').content;
        return {
          ok: true,
          json: async () => ({
            choices: [{
              finish_reason: 'stop',
              message: { content: JSON.stringify({ instagram: carousel
                ? {
                    caption: 'Swipe for a simple skincare routine.',
                    slides: [
                      { headline: 'Cleanse', body: 'Use a gentle cleanser.' },
                      { headline: 'Moisturize', body: 'Apply moisturizer.' },
                      { headline: 'Protect', body: 'Apply sunscreen.' },
                    ],
                  }
                : { caption: 'A simple skincare tip.' } }) },
            }],
          }),
        };
      };

      await callAIAndGenerateContent(
        carousel ? 'Create a practical skincare carousel' : 'Create a practical skincare post',
        brand,
        ['instagram'],
      );

      const consistencyInstruction = 'Match every step promised in the caption to an actionable step in the slides, in the same order, within 3-7 slides.';
      assert.equal(systemPrompt.includes(consistencyInstruction), carousel);
      if (carousel) assert.ok(systemPrompt.includes('Count actual steps, not hook or CTA slides; do not promise omitted steps.'));
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}
