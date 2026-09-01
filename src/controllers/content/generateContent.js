const User = require('../../models/user.js');
const Job = require('../../models/job');

const generateContent = async (req, res) => {
  let jobId = null;

  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const { prompt } = req.body;

    if (!prompt || prompt.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Topic is too short.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const platformsToGenerate = user.brandProfile?.platforms?.length > 0 
      ? user.brandProfile.platforms 
      : ['instagram', 'twitter'];

    const job = new Job({
      userId: userId,
      platforms: platformsToGenerate,
      originalContent: prompt,
      status: 'processing'
    });
    await job.save();
    jobId = job._id;

    console.log(`Job ${jobId} started for: ${platformsToGenerate.join(', ')}`);

    const generatedContent = await callAIAndGenerateContent(prompt, user, platformsToGenerate);
    console.log("Generated Content with Image:", generatedContent);

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
    console.error(`Job ${jobId} failed:`, error.message);
    if (jobId) {
      await Job.findByIdAndUpdate(jobId, { status: 'failed', error: error.message });
    }
    res.status(500).json({ success: false, message: 'Generation failed', error: error.message });
  }
};

const callAIAndGenerateContent = async (userPrompt, user, platforms) => {
  const { brandProfile } = user;

  const systemPrompt = `
    You are an expert Social Media Copywriter for "${brandProfile.companyName || 'our brand'}".
    
    --- 1. BRAND INTELLIGENCE ---
    INDUSTRY: ${brandProfile.industry || 'General Business'}
    TARGET AUDIENCE: ${brandProfile.targetAudience?.description || 'General Audience'}
       - Their Pain Point: "${brandProfile.targetAudience?.painPoint || ''}"
       - Their Desire: "${brandProfile.targetAudience?.desire || ''}"
    UNIQUE VALUE PROPOSITION (UVP): "${brandProfile.uvp || ''}"
    BRAND VOICE: ${brandProfile.brandVoice?.tone || 'Professional'} 
    EXTRA VOICE RULES: ${brandProfile.brandVoice?.description || 'Be human and engaging.'}

    --- 2. THE USER REQUEST ---
    Topic: "${userPrompt}"

    --- 3. OUTPUT INSTRUCTIONS (STRICT JSON) ---
    You must return a valid JSON object containing keys only for these platforms: ${platforms.join(', ')}.
    Follow these specific rules for each platform:

    ${platforms.includes('twitter') ? `
    "twitter": [
      { 
        "text": "Write a punchy tweet (max 280 chars). Use slang if appropriate. Include ONLY 2-3 specific hashtags. Do NOT use generic tags.",
        "image_url": "PLACEHOLDER_IMAGE"
      }
    ],` : ''}

    ${platforms.includes('linkedin') ? `
    "linkedin": [
      "Write a professional post with short paragraphs and line breaks."
    ],` : ''}

    ${platforms.includes('instagram') ? `
    "instagram": {
      "caption": "Write an engaging caption with a hook and emojis.",
      "image_url": "PLACEHOLDER_IMAGE"
    },` : ''}

    ${platforms.includes('email') ? `
    "email": {
      "subject": "Catchy subject line",
      "body": "Full email body focusing on pain points and solutions."
    },` : ''}

    Return ONLY raw JSON. No markdown.
  `;

  const groqUrl = "https://api.groq.com/openai/v1/chat/completions";
  
  const response = await fetch(groqUrl, {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt},
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    })
  });
 
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API Error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  
  if (!data.choices || !data.choices[0].message.content) {
    throw new Error("Groq returned empty response");
  }

  const rawText = data.choices[0].message.content;
  let generatedContent = JSON.parse(rawText);

  // --- CHANGED TO LOREMFLICKR FOR RELIABILITY ---
  const needsImage = platforms.some(p => ['twitter', 'instagram', 'facebook'].includes(p));
  
  if (needsImage) {
    // 1. Get first word of prompt for keyword (e.g. "Coffee")
    const keyword = encodeURIComponent(userPrompt.split(' ')[0]);
    // 2. Generate random number for cache busting
    const randomSeed = Math.floor(Math.random() * 10000);
    // 3. Create URL
    const imageUrl = `https://loremflickr.com/1080/1080/${keyword}?random=${randomSeed}`;
    
    console.log("Generated Image URL:", imageUrl);
    
    generatedContent.imageUrl = imageUrl;

    if (generatedContent.twitter && Array.isArray(generatedContent.twitter) && generatedContent.twitter[0]) {
      generatedContent.twitter[0].image_url = imageUrl;
    }
    if (generatedContent.instagram) {
      generatedContent.instagram.image_url = imageUrl;
    }
  }
  
  return generatedContent;
};

module.exports = { generateContent };