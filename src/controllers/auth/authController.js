const axios = require('axios');
const User = require('../../models/User');
const urls = require('../../config/urls');

// Helper to wait (sleep)
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------- 1. LOGIN (Start) ----------------
const instagramLogin = (req, res) => {
  // ✅ FIX: Get ID from URL query (since auth middleware is removed for this route)
  // Example URL: /api/v1/auth/instagram/login?userId=65a9...
  const userId = req.query.userId || req.user?.id;
 

  // Safety Check: If we don't know who the user is, stop here.
  if (!userId) {
    return res.status(400).send("Error: Missing 'userId' in URL. Please login again.");
  }

  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: process.env.INSTAGRAM_REDIRECT_URI,
    scope: 'instagram_business_basic,instagram_business_content_publish', 
    response_type: 'code',
    state: userId // We send the DB ID as 'state' to retrieve it later
  });

  res.redirect(`${urls.instagram.oauthAuthorize}?${params}`);
};

// ---------------- 2. CALLBACK (Finish) ----------------
const instagramCallback = async (req, res) => {
  const { code, state } = req.query; 

  // Validation
  if (!code) return res.status(400).send("No code provided");
  if (!state) return res.status(400).send("No state provided");
  
  try {
    // 1. Get Short Token
    const shortTokenRes = await axios.post(
      urls.instagram.accessToken,
      new URLSearchParams({
        client_id: process.env.INSTAGRAM_APP_ID,
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: process.env.INSTAGRAM_REDIRECT_URI, 
        code
      })
    );

    const { access_token: shortToken, user_id: instaUserId } = shortTokenRes.data;
       
    // 2. Get Long Token
    const longTokenRes = await axios.get(`${urls.instagram.graphApi}/access_token`, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        access_token: shortToken
      }
    });

    const longLivedToken = longTokenRes.data.access_token;

    // ✅ FIX START: Declare variable outside the block
    let updatedUser = null; 

    if (state) {
      // ✅ Assign to the outer variable
      updatedUser = await User.findByIdAndUpdate(state, {
        'socialAccounts.instagram.instagramId': instaUserId,
        'socialAccounts.instagram.accessToken': longLivedToken,
        'socialAccounts.instagram.isConnected': true,
        'socialAccounts.instagram.connectedAt': new Date()
      }, { new: true });
    }

    // ✅ Redirect the user back to your Frontend (Localhost)
    // This looks much better than just showing JSON in the browser.
    res.redirect(`${process.env.FRONTEND_URL}/onboarding?instagramSuccess=true`);
    
    // OR if you prefer JSON (keep your old line):
    

  } catch (e) {
    console.error("Callback Error:", e.response?.data || e.message);
    res.status(500).json(e.response?.data || { error: "Login failed" });
  }
};

// ---------------- 3. PUBLISH HELPER (Logic Only) ----------------
const publishImageToInstagram = async (instaId, accessToken, imageUrl, caption) => {
  
  try {
    // Step 1: Create Container
    console.log("Step 1: Creating Media Container...");
    const containerRes = await axios.post(
      `${urls.instagram.graphApi}/v24.0/${instaId}/media`,
      { image_url: imageUrl, caption, access_token: accessToken }
    );
    const containerId = containerRes.data.id;

    // Step 2: Poll for Status
    let isReady = false;
    let attempts = 0;
    while (!isReady && attempts < 10) {
      await wait(5000); // Wait 5s
      attempts++;
      
      const statusRes = await axios.get(
        `${urls.instagram.graphApi}/v24.0/${containerId}?fields=status_code&access_token=${accessToken}`
      );
      const status = statusRes.data.status_code;
      console.log(`Processing Status: ${status}`);

      if (status === 'FINISHED') isReady = true;
      else if (status === 'ERROR') throw new Error("Media processing failed");
    }

    if (!isReady) throw new Error("Timeout: Media took too long");

    // Step 3: Publish
    console.log("Step 3: Publishing...");
    const publishRes = await axios.post(
      `${urls.instagram.graphApi}/v24.0/${instaId}/media_publish`,
      { creation_id: containerId, access_token: accessToken }
    );

    return publishRes.data; // { id: "..." }

  } catch (error) {
    console.error("Publishing Helper Error:", error.response?.data || error.message);
    throw error; // Throw up to the route handler
  }
};

module.exports = {
  instagramLogin,
  instagramCallback,
  publishImageToInstagram
};