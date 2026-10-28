const User = require('../../models/User');
const Job = require('../../models/Job');
const urls = require('../../config/urls');
const { validGenerationBody, validBrandProfile } = require('../../utils/generationInput');
const generationConfig = require('../../config/generation')();
const { createGenerationLimiter } = require('../../utils/generationLimiter');
const generationLimiter = createGenerationLimiter(generationConfig);
const { createRecommenderClient } = require('../../utils/recommenderClient');
const fetchRecommendation = createRecommenderClient(urls.recommender);
const { generationFailure } = require('../../utils/generationFailure');
const { createGenerationDiagnostics } = require('../../utils/generationDiagnostics');
const { GenerationValidationError } = require('../../utils/generationValidationError');

const generateContent = async (req, res) => {
  let jobId = null;
  let reservation;
  const diagnostics = createGenerationDiagnostics();

  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const userId = req.user.id;
    if (!validGenerationBody(req.body)) {
      return res.status(400).json({
        success: false, code: 'INVALID_GENERATION_INPUT',
        message: 'Send only a prompt string: at least 5 characters after trimming and at most 5000 characters in total.'
      });
    }
    const prompt = req.body.prompt.trim();

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // 1. Validate Brand Profile Completeness
    const bp = user.brandProfile || {};
    if (!validBrandProfile(bp)) {
      return res.status(400).json({
        success: false, code: 'INVALID_BRAND_PROFILE',
        message: 'Incomplete brand profile or invalid brand fields. Complete onboarding with company name, industry, UVP, target audience, and supported platforms; text fields must not exceed 5000 characters.'
      });
    }
    const companyName = bp.companyName?.trim();
    const industry = bp.industry?.trim();
    const uvp = bp.uvp?.trim();
    const targetAudience = typeof bp.targetAudience === 'string'
      ? bp.targetAudience.trim()
      : (bp.targetAudience?.description?.trim() || '');

    const platformsToGenerate = user.brandProfile?.platforms?.length > 0
      ? user.brandProfile.platforms
      : ['instagram', 'twitter'];

    reservation = generationLimiter.acquire(userId);
    if (!reservation.allowed) {
      const messages = {
        GENERATION_RATE_LIMIT: 'Generation request limit reached. Please try again later.',
        GENERATION_IN_PROGRESS: 'A generation is already in progress. Please wait for it to finish.',
        GENERATION_CAPACITY: 'Generation is temporarily at capacity. Please try again later.',
      };
      res.set('Retry-After', String(reservation.retryAfter));
      return res.status(reservation.status).json({
        success: false, code: reservation.code, message: messages[reservation.code],
      });
    }

    // 2. Fetch Recommendation from Python Service (with strict timeout & graceful fallback)
    const recommenderPayload = {
      brand_name: companyName,
      business_description: uvp,
      industry: industry,
      target_audience: targetAudience,
    };
    if (bp.brandVoice?.tone?.trim()) {
      recommenderPayload.brand_tone = bp.brandVoice.tone.trim();
    }

    let recommendation = null;
    let recommenderReason = null;

    try {
      const recResponse = await fetchRecommendation(recommenderPayload);

      if (recResponse.ok) {
        const data = recResponse.data;
        const candidateRec = (data && data.recommendation) ? data.recommendation : data;
        if (candidateRec && (candidateRec.recommended_topic || candidateRec.topic || candidateRec.trending_topics || candidateRec.brand_name)) {
          recommendation = candidateRec;
        } else {
          recommenderReason = 'Malformed recommendation response structure';
          console.warn('Recommender warning:', recommenderReason);
        }
      } else {
        recommenderReason = `Recommender returned HTTP ${recResponse.status}`;
        console.warn('Recommender warning:', recommenderReason);
      }
    } catch (recErr) {
      recommenderReason = recErr.code === 'RECOMMENDER_AUTH_UNAVAILABLE'
        ? 'Recommender authentication unavailable'
        : recErr.name === 'TimeoutError'
        ? `Recommender request timed out after ${urls.recommender.timeoutMs}ms`
        : 'Recommender service unavailable';
      console.warn('Recommender warning:', recommenderReason);
    }

    // 3. Initialize Job Record
    diagnostics.enter('job_create');
    const job = new Job({
      userId: userId,
      platforms: platformsToGenerate,
      originalContent: prompt,
      status: 'processing'
    });
    await job.save();
    jobId = job._id;

    console.log(`Job ${jobId} started for: ${platformsToGenerate.join(', ')}`);

    // 4. Generate Content via LLM
    const generatedContent = await callAIAndGenerateContent(
      prompt,
      user,
      platformsToGenerate,
      recommendation,
      recommenderReason,
      diagnostics
    );

    diagnostics.enter('job_complete');
    const finishedJob = await Job.findByIdAndUpdate(jobId, {
      status: 'completed',
      generatedContent: generatedContent,
      completedAt: new Date()
    }, { new: true });

    res.status(200).json({
      success: true,
      message: 'Content generated successfully!',
      job: finishedJob
    });

  } catch (error) {
    const failure = generationFailure(error);
    // Provider/driver messages can contain credentials, prompts or response bodies.
    console.error(JSON.stringify(diagnostics.failure(error, jobId ? String(jobId) : null)));
    if (jobId) {
      try {
        await Job.findByIdAndUpdate(jobId, { status: 'failed', error: failure.message });
      } catch (persistenceError) {
        diagnostics.enter('job_failure_save');
        console.error(JSON.stringify(diagnostics.failure(persistenceError, String(jobId))));
      }
    }
    if (failure.status === 504) {
      return res.status(504).json({
        success: false, code: failure.code, message: failure.message,
      });
    }
    res.status(500).json({
      success: false, code: failure.code, message: failure.message, error: failure.message,
    });
  } finally {
    // Hold the slot through provider and persistence work, even if the client
    // disconnects. Releasing on socket close would allow overlapping calls.
    if (reservation?.allowed) reservation.release();
  }
};

const cleanAndParseJSON = (rawText) => {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Groq returned empty response');
  }
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerErr) {
        throw new Error(`Failed to parse LLM JSON response: ${err.message}`);
      }
    }
    throw new Error(`Failed to parse LLM JSON response: ${err.message}`);
  }
};

const validateAndNormalizeContent = (content, platforms, isCarousel) => {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new GenerationValidationError('LLM output is not a valid JSON object', 'INVALID_OUTPUT_OBJECT');
  }

  const nonemptyText = value => typeof value === 'string' && value.trim().length > 0;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const platform of platforms) {
    if (!Object.hasOwn(content, platform)) {
      throw new GenerationValidationError(`LLM output missing required "${platform}" object or content`, 'MISSING_PLATFORM', platform);
    }
  }

  if (platforms.includes('twitter')) {
    if (!Array.isArray(content.twitter) || content.twitter.length === 0) {
      throw new GenerationValidationError('LLM output requires non-empty "twitter" posts of at most 280 characters', 'INVALID_TWITTER_POSTS', 'twitter');
    }
    for (const tweet of content.twitter) {
      if (!object(tweet) || !nonemptyText(tweet.text)) {
        throw new GenerationValidationError('LLM output requires non-empty "twitter" posts of at most 280 characters', 'MISSING_TWITTER_TEXT', 'twitter');
      }
      if (Array.from(tweet.text).length > 280) {
        throw new GenerationValidationError('LLM output requires non-empty "twitter" posts of at most 280 characters', 'TWITTER_TEXT_TOO_LONG', 'twitter');
      }
    }
  }

  if (platforms.includes('linkedin')) {
    // Providers sometimes use a single post or Twitter-style text objects.
    // Recover only explicit text, never stringify objects or guess body fields.
    const posts = Array.isArray(content.linkedin) ? content.linkedin : [content.linkedin];
    if (posts.length === 0) {
      throw new GenerationValidationError('LLM output requires non-empty LinkedIn text posts', 'INVALID_PLATFORM_POSTS', 'linkedin');
    }
    content.linkedin = posts.map(post => {
      if (nonemptyText(post)) return post;
      if (object(post) && Object.keys(post).length === 1 && Object.hasOwn(post, 'text') && nonemptyText(post.text)) {
        return post.text;
      }
      throw new GenerationValidationError('LLM output requires non-empty LinkedIn text posts', 'INVALID_PLATFORM_POSTS', 'linkedin');
    });
  }

  for (const platform of ['facebook', 'blog']) {
    if (platforms.includes(platform) && (!Array.isArray(content[platform])
      || content[platform].length === 0 || !content[platform].every(nonemptyText))) {
      throw new GenerationValidationError(`LLM output requires a non-empty "${platform}" array of non-empty strings`, 'INVALID_PLATFORM_POSTS', platform);
    }
  }

  if (platforms.includes('email') && (!object(content.email)
    || !nonemptyText(content.email.subject) || !nonemptyText(content.email.body))) {
    throw new GenerationValidationError('LLM output requires non-empty "email.subject" and "email.body" strings', 'INVALID_EMAIL', 'email');
  }

  if (platforms.includes('instagram')) {
    if (!object(content.instagram)) {
      throw new GenerationValidationError('LLM output missing required "instagram" object', 'INVALID_INSTAGRAM_OBJECT', 'instagram');
    }
    if (typeof content.instagram.caption !== 'string' || content.instagram.caption.trim().length === 0) {
      throw new GenerationValidationError('LLM output missing non-empty "instagram.caption" string', 'MISSING_INSTAGRAM_CAPTION', 'instagram');
    }

    if (isCarousel) {
      content.instagram.content_type = 'carousel';
      // Preserve caption-based recovery for legacy responses that omit slides.
      // Supplied slides must contain real content; never stringify invalid values.
      if (content.instagram.slides === undefined) {
        // Recover 3 slides from caption
        const sentences = content.instagram.caption.split(/(?<=[.!?])\s+/).filter(Boolean);
        content.instagram.slides = [
          { slide_number: 1, headline: "Overview", body: sentences[0] || content.instagram.caption },
          { slide_number: 2, headline: "Key Details", body: sentences.slice(1, -1).join(' ') || sentences[0] || content.instagram.caption },
          { slide_number: 3, headline: "Take Action", body: sentences[sentences.length - 1] || "Save this post and visit link in bio." }
        ];
      } else {
        if (!Array.isArray(content.instagram.slides) || content.instagram.slides.length < 3) {
          throw new GenerationValidationError('LLM output requires at least three valid Instagram carousel slides', 'INVALID_CAROUSEL_SLIDES', 'instagram');
        }
        content.instagram.slides = content.instagram.slides.slice(0, 7).map((slide, index) => {
          if (nonemptyText(slide)) {
            return { slide_number: index + 1, headline: slide.slice(0, 50), body: slide };
          }
          if (!object(slide) || !nonemptyText(slide.headline) || !nonemptyText(slide.body)) {
            throw new GenerationValidationError('LLM output requires non-empty carousel slide headlines and bodies', 'INVALID_CAROUSEL_SLIDE_TEXT', 'instagram');
          }
          return { slide_number: index + 1, headline: slide.headline, body: slide.body };
        });
      }
    } else {
      content.instagram.content_type = 'image';
    }
  }

  // Only requested platforms may reach persistence or results. Provider-added
  // metadata is discarded; trusted image and grounding fields are added below.
  return Object.fromEntries(platforms.map(platform => [platform, content[platform]]));
};

const callAIAndGenerateContent = async (userPrompt, user, platforms, recommendation = null, recommenderReason = null, diagnostics = createGenerationDiagnostics()) => {
  diagnostics.enter('prompt_preparation');
  const { brandProfile } = user;
  const targetAudienceStr = typeof brandProfile?.targetAudience === 'string'
    ? brandProfile.targetAudience
    : (brandProfile?.targetAudience?.description || 'General Audience');

  const recPostingWindow = recommendation?.recommended_posting_time
    ? `${recommendation.recommended_posting_time.day} ${recommendation.recommended_posting_time.start}-${recommendation.recommended_posting_time.end} (${recommendation.recommended_posting_time.timezone})`
    : (recommendation?.recommended_posting_time?.utc || 'N/A');

  const recFormat = recommendation?.recommended_content_type?.value || recommendation?.recommended_format || 'N/A';
  const isCarousel = (recFormat && recFormat.toLowerCase() === 'carousel') || /carousel|swipe|slides/i.test(userPrompt);

  const recEngagement = recommendation?.predicted_engagement?.value != null
    ? `${(recommendation.predicted_engagement.value * 100).toFixed(2)}% engagement rate (${recommendation.predicted_engagement.label || 'Estimated'})`
    : (recommendation?.engagement_prediction?.predicted_likes != null ? `${recommendation.engagement_prediction.predicted_likes} estimated likes` : 'N/A');

  const recommendationSignals = recommendation ? `
    --- 1.5. DATA-BACKED RECOMMENDATION SIGNALS ---
    GUIDANCE ROLE: ADVISORY SUPPORTING GUIDANCE ONLY (Never override user brief)
    RECOMMENDED TOPIC FOCUS: "${recommendation.recommended_topic || recommendation.topic || 'N/A'}"
    OPTIMAL CONTENT FORMAT: "${recFormat}"
    RECOMMENDED POSTING WINDOW: "${recPostingWindow}"
    PREDICTED ENGAGEMENT POTENTIAL: ${recEngagement}

    CRITICAL RULES ON GUIDANCE HIERARCHY:
    1. The USER BRIEF in Section 2 is AUTHORITATIVE and the primary directive. Never replace, alter, or hijack the user's specific requested topic with the recommended topic focus.
    2. Use the recommended topic focus ONLY as an advisory supporting hook, angle, or context to enrich the user's brief.
    3. Follow the optimal content format (${isCarousel ? 'multi-slide carousel' : 'single image post'}).
` : '';

  const systemPrompt = `
    You are an expert Social Media Copywriter for "${brandProfile.companyName || 'our brand'}".

    --- 1. BRAND INTELLIGENCE ---
    INDUSTRY: ${brandProfile.industry || 'General Business'}
    TARGET AUDIENCE: ${targetAudienceStr}
       - Their Pain Point: "${brandProfile.targetAudience?.painPoint || ''}"
       - Their Desire: "${brandProfile.targetAudience?.desire || ''}"
    UNIQUE VALUE PROPOSITION (UVP): "${brandProfile.uvp || ''}"
    BRAND VOICE: ${brandProfile.brandVoice?.tone || 'Professional'}
    EXTRA VOICE RULES: ${brandProfile.brandVoice?.description || 'Be human and engaging.'}
${recommendationSignals}
    --- 2. THE USER REQUEST ---
    Topic: "${userPrompt}"

    --- 3. OUTPUT INSTRUCTIONS (STRICT JSON) ---
    You must return a valid JSON object containing keys only for these platforms: ${platforms.join(', ')}.
    Use only hashtags directly relevant to the user brief and brand.
    Follow these specific rules for each platform:

    ${platforms.includes('twitter') ? `
    "twitter": [
      {
        "text": "Write a punchy tweet (max 280 chars). Use slang if appropriate. Include ONLY 2-3 specific hashtags. Do NOT use generic tags.",
        "image_url": "PLACEHOLDER_IMAGE"
      }
    ],` : ''}

    ${platforms.includes('linkedin') ? `
    LinkedIn must be a non-empty array of plain text strings, not an object.
    "linkedin": [
      "Write a professional post with short paragraphs and line breaks."
    ],` : ''}

    ${platforms.includes('facebook') ? `
    "facebook": [
      "Write an engaging Facebook post with a clear hook, useful details, and a call to action."
    ],` : ''}

    ${platforms.includes('blog') ? `
    "blog": [
      "Write a concise blog draft with a title, introductory paragraph, useful sections, and a conclusion."
    ],` : ''}

    ${platforms.includes('instagram') ? (isCarousel ? `
    "instagram": {
      "caption": "Write an engaging, complete caption that introduces the carousel with a hook, summarizes the value, prompts readers to swipe through, and concludes with relevant hashtags. Match every step promised in the caption to an actionable step in the slides, in the same order, within 3-7 slides. Count actual steps, not hook or CTA slides; do not promise omitted steps.",
      "content_type": "carousel",
      "slides": [
        {
          "slide_number": 1,
          "headline": "Hook / Title Slide Headline",
          "body": "Opening context or hook sentence"
        },
        {
          "slide_number": 2,
          "headline": "Core Insight 1",
          "body": "Actionable insight, step, or value nugget"
        },
        {
          "slide_number": 3,
          "headline": "Call To Action",
          "body": "Clear next step for the reader (e.g., Save this post, comment below, check link in bio)"
        }
      ],
      "image_url": "PLACEHOLDER_IMAGE"
    },` : `
    "instagram": {
      "caption": "Write an engaging single-image caption with a hook, body paragraphs, call to action, and relevant hashtags.",
      "content_type": "image",
      "image_url": "PLACEHOLDER_IMAGE"
    },`) : ''}

    ${platforms.includes('email') ? `
    "email": {
      "subject": "Catchy subject line",
      "body": "Full email body focusing on pain points and solutions."
    },` : ''}

    Return ONLY raw JSON. No markdown.
  `;

  const groqUrl = urls.groq.chatCompletions;
  const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const groqSignal = AbortSignal.timeout(generationConfig.groqTimeoutMs);
  let data;

  try {
    diagnostics.enter('provider_request');
    const response = await fetch(groqUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: groqSignal,
      body: JSON.stringify({
        model: groqModel,
        // Keep more of the bounded completion budget available for content.
        ...(groqModel === 'openai/gpt-oss-20b' ? { reasoning_effort: 'low' } : {}),
        messages: [
          { role: "system", content: systemPrompt},
          { role: "user", content: userPrompt }
        ],
        n: 1,
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_completion_tokens: generationConfig.groqMaxOutputTokens,
      })
    });

    diagnostics.providerStatus(response.status);
    if (!response.ok) {
      diagnostics.enter('provider_http');
      // Discard an upstream error body; never persist or log provider diagnostics.
      await response.body?.cancel();
      throw new Error('Content provider request failed');
    }
    diagnostics.enter('provider_body');
    data = await response.json();
  } catch (error) {
    // Body reads may throw AbortError instead of the deadline's TimeoutError.
    // Preserve the deadline reason so both phases return the same API response.
    throw groqSignal.aborted ? groqSignal.reason : error;
  }

  diagnostics.completion(data);
  if (!Array.isArray(data?.choices) || !data.choices[0]?.message?.content) {
    diagnostics.enter('output_empty');
    throw new Error("Groq returned empty response");
  }
  if (data.choices[0].finish_reason === 'length') {
    diagnostics.enter('output_truncated');
    throw new Error('Groq response exceeded the completion token limit');
  }

  const rawText = data.choices[0].message.content;
  diagnostics.enter('output_parse');
  const parsed = cleanAndParseJSON(rawText);
  diagnostics.enter('output_validation');
  let generatedContent = validateAndNormalizeContent(parsed, platforms, isCarousel);

  // --- CHANGED TO LOREMFLICKR FOR RELIABILITY ---
  const needsImage = platforms.some(p => ['twitter', 'instagram', 'facebook'].includes(p));

  if (needsImage) {
    // 1. Get first word of prompt for keyword (e.g. "Coffee")
    const keyword = encodeURIComponent(userPrompt.split(' ')[0]);
    // 2. Generate random number for cache busting
    const randomSeed = Math.floor(Math.random() * 10000);
    // 3. Create URL
    const imageUrl = `${urls.image.loremFlickr}/1080/1080/${keyword}?random=${randomSeed}`;


    generatedContent.imageUrl = imageUrl;

    if (generatedContent.twitter && Array.isArray(generatedContent.twitter) && generatedContent.twitter[0]) {
      generatedContent.twitter[0].image_url = imageUrl;
    }
    if (generatedContent.instagram) {
      generatedContent.instagram.image_url = imageUrl;
    }
  }

  generatedContent.grounding = recommendation ? {
    isGrounded: true,
    recommendation: recommendation
  } : {
    isGrounded: false,
    recommendation: null,
    reason: recommenderReason || 'Ungrounded fallback generation'
  };

  return generatedContent;
};

module.exports = {
  generateContent,
  callAIAndGenerateContent,
  cleanAndParseJSON,
  validateAndNormalizeContent,
};
