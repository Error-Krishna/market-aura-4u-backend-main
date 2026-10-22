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

const {
  cleanAndParseJSON,
  validateAndNormalizeContent,
  callAIAndGenerateContent,
} = require('../src/controllers/content/generateContent');

describe('Offline Caption Quality, Prompt Hierarchy & Resilience Suite', () => {
  const representativeBrands = [
    {
      name: 'Lumiere Cosmetics',
      brandProfile: {
        companyName: 'Lumiere Cosmetics',
        industry: 'beauty',
        uvp: 'Cruelty-free, vegan skincare and makeup formulated with plant-based actives.',
        targetAudience: 'young adults interested in clean beauty',
        brandVoice: { tone: 'Playful & Inspiring', description: 'Be transparent, empowering, and clean.' },
      },
      brief: 'Launch of our new organic plum hydrating lip tint with SPF 15',
      recommendation: {
        recommended_topic: 'skincare',
        recommended_content_type: { value: 'carousel' },
        recommended_hashtags: ['#skincare', '#norvina', '#instabeauty', '#wakeupandmakeup'],
        recommended_posting_time: { day: 'Saturday', start: '10:00', end: '11:00', timezone: 'America/New_York' },
        predicted_engagement: { value: 0.0261, label: 'Medium' },
      },
    },
    {
      name: 'Happy Tails',
      brandProfile: {
        companyName: 'Happy Tails',
        industry: 'pet supplies',
        uvp: 'Organic dog treats and sustainable eco-friendly chew toys.',
        targetAudience: 'eco-conscious pet parents',
        brandVoice: { tone: 'Warm & Friendly', description: 'Cheerfully informative, loving towards pets.' },
      },
      brief: 'Why natural sweet potato chews are safer for teething puppies',
      recommendation: {
        recommended_topic: 'dogs',
        recommended_content_type: { value: 'image' },
        recommended_hashtags: ['#dogs', '#pet', '#dogsofinstagram', '#pets'],
        recommended_posting_time: { day: 'Sunday', start: '12:00', end: '13:00', timezone: 'UTC' },
        predicted_engagement: { value: 0.0385, label: 'High' },
      },
    },
    {
      name: 'FitLife Gear',
      brandProfile: {
        companyName: 'FitLife Gear',
        industry: 'fitness',
        uvp: 'High-performance activewear and eco-conscious grip yoga mats.',
        targetAudience: 'yoga practitioners and daily athletes',
        brandVoice: { tone: 'Empowering & Disciplined', description: 'Action-oriented and focused on progress.' },
      },
      brief: '5 common yoga alignment mistakes in downward dog and how to fix them',
      recommendation: {
        recommended_topic: 'training',
        recommended_content_type: { value: 'carousel' },
        recommended_hashtags: ['#fitnesslifestyle', '#training', '#shredded', '#yogainspiration'],
        recommended_posting_time: { day: 'Wednesday', start: '07:00', end: '08:00', timezone: 'UTC' },
        predicted_engagement: { value: 0.0410, label: 'High' },
      },
    },
    {
      name: 'Tech Innovate',
      brandProfile: {
        companyName: 'Tech Innovate',
        industry: 'software',
        uvp: 'B2B SaaS platform automating cross-team HR workflows and onboarding.',
        targetAudience: 'HR directors and operations executives',
        brandVoice: { tone: 'Professional & Authoritative', description: 'Clear, outcome-focused, no fluff.' },
      },
      brief: 'Announcing our 1-click employee onboarding workflow integration with Slack',
      recommendation: null, // Test ungrounded / fallback case
    },
  ];

  let origFetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    process.env.GROQ_API_KEY = 'mock_key_for_offline_testing';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  // 1. Prompt Hierarchy & Brief Authority Tests
  test('Prompt hierarchy: User brief is marked authoritative and recommender is advisory', async () => {
    const brand = representativeBrands[0]; // Lumiere
    let interceptedSystemPrompt = '';

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      interceptedSystemPrompt = body.messages.find((m) => m.role === 'system').content;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  instagram: {
                    caption: 'Swipe through to discover our Organic Plum Lip Tint! #skincare',
                    content_type: 'carousel',
                    slides: [
                      { slide_number: 1, headline: 'Plum Hydration', body: 'Meet the new lip tint' },
                      { slide_number: 2, headline: 'SPF 15 Protection', body: 'Clean sun defense' },
                      { slide_number: 3, headline: 'Shop Now', body: 'Available online today' },
                    ],
                  },
                }),
              },
            },
          ],
        }),
      };
    };

    const user = { brandProfile: brand.brandProfile };
    await callAIAndGenerateContent(brand.brief, user, ['instagram'], brand.recommendation);

    // Verify Section 2 (Brief) is present and verbatim
    assert.ok(interceptedSystemPrompt.includes('--- 2. THE USER REQUEST ---'));
    assert.ok(interceptedSystemPrompt.includes(`Topic: "${brand.brief}"`));

    // Verify Section 1.5 marks recommendations as ADVISORY SUPPORTING GUIDANCE
    assert.ok(interceptedSystemPrompt.includes('--- 1.5. DATA-BACKED RECOMMENDATION SIGNALS ---'));
    assert.ok(interceptedSystemPrompt.includes('GUIDANCE ROLE: ADVISORY SUPPORTING GUIDANCE ONLY'));
    assert.ok(interceptedSystemPrompt.includes('Never replace, alter, or hijack the user\'s specific requested topic'));
    assert.ok(interceptedSystemPrompt.includes('RECOMMENDED TOPIC FOCUS: "skincare"'));
    assert.ok(interceptedSystemPrompt.includes('#skincare #norvina #instabeauty #wakeupandmakeup'));
  });

  // 2. Structured Carousel Generation & Validation
  test('Structured Carousel: Format carousel generates 3-7 slides and valid caption string', async () => {
    const brand = representativeBrands[2]; // FitLife Gear
    const mockCarouselSlides = [
      { slide_number: 1, headline: 'Downward Dog Alignment', body: '5 common mistakes to avoid.' },
      { slide_number: 2, headline: 'Mistake 1: Collapsing Wrists', body: 'Press evenly through all 10 fingers.' },
      { slide_number: 3, headline: 'Mistake 2: Straining Shoulders', body: 'Rotate triceps outward to broaden.' },
      { slide_number: 4, headline: 'Mistake 3: Locked Knees', body: 'Keep a micro-bend to protect hamstrings.' },
      { slide_number: 5, headline: 'Save for Your Next Flow', body: 'Bookmark this guide and tag a yogi friend!' },
    ];

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                instagram: {
                  caption: 'Master your Downward Dog! Swipe through for 5 alignment cues. #fitnesslifestyle #training',
                  content_type: 'carousel',
                  slides: mockCarouselSlides,
                },
              }),
            },
          },
        ],
      }),
    });

    const user = { brandProfile: brand.brandProfile };
    const result = await callAIAndGenerateContent(brand.brief, user, ['instagram'], brand.recommendation);

    assert.ok(result.instagram);
    assert.strictEqual(result.instagram.content_type, 'carousel');
    assert.strictEqual(typeof result.instagram.caption, 'string');
    assert.ok(result.instagram.caption.length > 10);
    assert.ok(Array.isArray(result.instagram.slides));
    assert.strictEqual(result.instagram.slides.length, 5);

    // Verify slide schema
    result.instagram.slides.forEach((slide, idx) => {
      assert.strictEqual(slide.slide_number, idx + 1);
      assert.ok(typeof slide.headline === 'string' && slide.headline.length > 0);
      assert.ok(typeof slide.body === 'string' && slide.body.length > 0);
    });
  });

  // 3. Single Image Generation & Validation
  test('Single Image: Format image generates caption string and content_type="image"', async () => {
    const brand = representativeBrands[1]; // Happy Tails
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                instagram: {
                  caption: 'Teething puppy? Natural sweet potato chews provide safe, gentle relief without splintering! 🐶 #dogs #pet',
                  content_type: 'image',
                },
              }),
            },
          },
        ],
      }),
    });

    const user = { brandProfile: brand.brandProfile };
    const result = await callAIAndGenerateContent(brand.brief, user, ['instagram'], brand.recommendation);

    assert.ok(result.instagram);
    assert.strictEqual(result.instagram.content_type, 'image');
    assert.strictEqual(typeof result.instagram.caption, 'string');
    assert.ok(result.instagram.caption.includes('sweet potato chews'));
  });

  // 4. JSON Parsing Resilience & Markdown Code Fence Stripping
  test('Parsing resilience: Correctly strips ```json fences and trims whitespace', () => {
    const fencedPayload = '```json\n{\n  "instagram": {\n    "caption": "Fenced caption"\n  }\n}\n```';
    const parsed = cleanAndParseJSON(fencedPayload);
    assert.strictEqual(parsed.instagram.caption, 'Fenced caption');

    const bareFencedPayload = '```\n{\n  "instagram": {\n    "caption": "Bare fence caption"\n  }\n}\n```';
    const parsedBare = cleanAndParseJSON(bareFencedPayload);
    assert.strictEqual(parsedBare.instagram.caption, 'Bare fence caption');

    const noisyPayload = 'Here is the generated content JSON you requested:\n{"instagram": {"caption": "Noisy caption"}}\nHope this helps!';
    const parsedNoisy = cleanAndParseJSON(noisyPayload);
    assert.strictEqual(parsedNoisy.instagram.caption, 'Noisy caption');
  });

  test('Parsing resilience: Controlled error on completely invalid response', () => {
    assert.throws(
      () => cleanAndParseJSON('This is pure text with no JSON whatsoever.'),
      /Failed to parse LLM JSON response/
    );
    assert.throws(() => cleanAndParseJSON(''), /Groq returned empty response/);
  });

  // 5. Output Validation & Carousel Slide Recovery
  test('Validation: Reconstructs 3 slides if carousel format lacks slides array', () => {
    const rawContent = {
      instagram: {
        caption: 'Sentence one with hook. Sentence two with core value details. Sentence three with call to action.',
      },
    };

    const normalized = validateAndNormalizeContent(rawContent, ['instagram'], true);
    assert.strictEqual(normalized.instagram.content_type, 'carousel');
    assert.ok(Array.isArray(normalized.instagram.slides));
    assert.strictEqual(normalized.instagram.slides.length, 3);
    assert.strictEqual(normalized.instagram.slides[0].slide_number, 1);
    assert.strictEqual(normalized.instagram.slides[2].slide_number, 3);
  });

  test('Validation: Throws controlled error if required instagram object or caption is missing', () => {
    assert.throws(
      () => validateAndNormalizeContent({}, ['instagram'], false),
      /LLM output missing required "instagram" object/
    );
    assert.throws(
      () => validateAndNormalizeContent({ instagram: { caption: '   ' } }, ['instagram'], false),
      /LLM output missing non-empty "instagram.caption" string/
    );
  });

  // 6. Ungrounded / Recommender Unavailable Behavior
  test('Ungrounded fallback: Successfully handles null recommendation', async () => {
    const brand = representativeBrands[3]; // Tech Innovate (recommendation: null)
    let interceptedPrompt = '';

    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      interceptedPrompt = body.messages.find((m) => m.role === 'system').content;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  instagram: {
                    caption: 'Automate onboarding in seconds with 1-click Slack integration. #hrtech #automation',
                    content_type: 'image',
                  },
                }),
              },
            },
          ],
        }),
      };
    };

    const user = { brandProfile: brand.brandProfile };
    const result = await callAIAndGenerateContent(
      brand.brief,
      user,
      ['instagram'],
      null,
      'Recommender service offline'
    );

    // Verifies Section 1.5 is omitted when recommendations are absent
    assert.strictEqual(interceptedPrompt.includes('--- 1.5. DATA-BACKED RECOMMENDATION SIGNALS ---'), false);

    // Verifies grounding metadata accurately reports ungrounded state
    assert.strictEqual(result.grounding.isGrounded, false);
    assert.strictEqual(result.grounding.recommendation, null);
    assert.strictEqual(result.grounding.reason, 'Recommender service offline');

    // Verifies valid Instagram output structure
    assert.strictEqual(typeof result.instagram.caption, 'string');
    assert.strictEqual(result.instagram.content_type, 'image');
  });
});
