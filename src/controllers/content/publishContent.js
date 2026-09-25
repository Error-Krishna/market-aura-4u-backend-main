const Job = require('../../models/Job');
const { TwitterApi } = require('twitter-api-v2');
const path = require('path');
const axios = require('axios'); // Required for downloading images

// ===============================================================
// 🚀 TWITTER PUBLISHING (FIXED & ROBUST)
// ===============================================================

const publishToTwitter = async (twitterContent) => {
  console.log('--- 🚀 PUBLISHING TO TWITTER ---');

  // 1. SAFELY EXTRACT POST DATA
  // Fix: Handle if content is an array (from DB) or a single object
  const post = Array.isArray(twitterContent) ? twitterContent[0] : twitterContent;

  if (!post) {
    throw new Error('Twitter content structure is invalid.');
  }

  const tweetText = post.text;
  
  // Look for 'image_url' from your database object
  const imageUrl = post.image_url;

  console.log('Received post object:', post);

  if (imageUrl) {
    console.log('🖼️ Image URL found:', imageUrl);
  } else {
    console.log('No image_url provided in post object.');
  }

  if (!tweetText) {
    throw new Error('No tweet text found.');
  }

  // 2. CHECK CREDENTIALS
  if (!process.env.TWITTER_API_KEY ||
      !process.env.TWITTER_API_SECRET ||
      !process.env.TWITTER_ACCESS_TOKEN ||
      !process.env.TWITTER_ACCESS_SECRET) {
        
    console.error('❌ Missing Twitter OAuth 1.0a credentials in .env file.');
    throw new Error('Twitter API credentials are not configured on the server. Check .env file.');
  }

  console.log('📝 Tweet Text:', tweetText);

  try {
    const twitterClient = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_SECRET,
    });

    const rwClient = twitterClient.readWrite;
    let mediaId = null;

    // 3. IMAGE UPLOAD LOGIC
    if (imageUrl) {
      try {
        console.log('...downloading image from URL...');
        
        // Download the image as a buffer
        const response = await axios.get(imageUrl, { 
          responseType: 'arraybuffer' 
        });
        const imageBuffer = Buffer.from(response.data, 'binary');
        
        // Get the MIME type (e.g., 'image/png')
        const mimeType = response.headers['content-type'];
        
        if (!mimeType) {
          throw new Error('Could not determine image MIME type.');
        }

        console.log(`...download complete. MIME Type: ${mimeType}`);
        console.log('...uploading media to Twitter...');

        // Upload the buffer to Twitter (v1.1 API)
        mediaId = await twitterClient.v1.uploadMedia(imageBuffer, { 
          mimeType: mimeType 
        });
        
        console.log(`...media uploaded, ID: ${mediaId}`);

      } catch (uploadError) {
        console.error('❌ Twitter media download/upload failed:', uploadError.message);
        // We throw here to stop the tweet from going out without the image
        // If you prefer to post text-only on image failure, remove this throw.
        throw new Error(`Failed to upload media: ${uploadError.message}`);
      }
    }

    // 4. POST TWEET (with or without media)
    console.log('🐦 Posting tweet...');

    const tweetPayload = { text: tweetText };
    if (mediaId) {
      tweetPayload.media = { media_ids: [mediaId] };
    }

    const { data } = await rwClient.v2.tweet(tweetPayload);
    
    console.log('✅ Tweet posted successfully!');
    console.log(`🔗 URL: https://x.com/i/status/${data.id}`);
    
    return { 
      success: true, 
      url: `https://x.com/i/status/${data.id}`,
      tweetId: data.id,
      real: true
    };

  } catch (error) {
    console.error('❌ Twitter API publishing failed.');
    let simpleErrorMessage = 'Failed to post tweet.';

    if (error.data && error.data.detail) {
      console.error('API Error Details:', error.data.detail);
      simpleErrorMessage = `Twitter API Error: ${error.data.detail}`;
    } else {
      console.error('Error:', error.message);
      simpleErrorMessage = error.message;
    }
    
    throw new Error(simpleErrorMessage);
  }
};

// ===============================================================
// 📧 OTHER PLATFORMS (SIMULATED / PLACEHOLDERS)
// ===============================================================

const publishToEmail = async (emailContent) => {
  console.log('📧 Email ready');
  return { 
    success: true, 
    message: 'Email content ready',
    simulated: true
  };
};

const publishToLinkedIn = async (linkedinContent) => {
  console.log('💼 LinkedIn ready');
  return { 
    success: true, 
    message: 'LinkedIn post ready',
    simulated: true
  };
};

const publishToBlog = async (blogContent) => {
  console.log('📝 Blog ready');
  return { 
    success: true, 
    message: 'Blog post ready',
    simulated: true
  };
};

const publishToInstagram = async (instagramContent) => {
  console.log('📸 Instagram ready');
  return { 
    success: true, 
    message: 'Instagram post ready',
    simulated: true
  };
};

// ===============================================================
// 🛎️ MAIN PUBLISHING CONTROLLER
// ===============================================================

const publishContent = async (req, res) => {
  try {
    const { jobId, platforms } = req.body;
    const userId = req.user.id;

    console.log(`📦 Publishing job ${jobId} to: ${platforms}`);

    // Fetch Job & Verify Ownership
    const job = await Job.findOne({ _id: jobId, userId: userId });
    
    // Check if job exists and is completed
    if (!job || job.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Job not ready or not found' });
    }

    // Convert Map to Object if necessary (Mongoose Map handling)
    const generatedContent = job.generatedContent instanceof Map 
      ? Object.fromEntries(job.generatedContent) 
      : job.generatedContent;

    const results = [];
    
    for (const platform of platforms) {
      const content = generatedContent[platform];
      
      if (!content) {
        results.push({ platform, success: false, message: `No ${platform} content generated` });
        continue;
      }

      try {
        let result;
        switch (platform) {
          case 'twitter':
            result = await publishToTwitter(content);
            break;
          case 'linkedin':
            result = await publishToLinkedIn(content);
            break;
          case 'blog':
            result = await publishToBlog(content);
            break;
          case 'instagram':
            result = await publishToInstagram(content);
            break;
          case 'email':
            result = await publishToEmail(content);
            break;
          default:
            result = { success: false, message: 'Platform not supported' };
        }
        
        results.push({ platform, ...result });
        
      } catch (error) {
        results.push({ platform, success: false, message: error.message });
      }
    }

    const successful = results.filter(r => r.success).length;
    
    res.json({
      success: true,
      message: `Published: ${successful} successful, ${results.length - successful} failed`,
      results: results
    });

  } catch (error) {
    console.error('Publishing error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
};

module.exports = {
  publishContent
};