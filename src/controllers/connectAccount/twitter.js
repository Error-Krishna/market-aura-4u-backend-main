const { TwitterApi } = require('twitter-api-v2');
const User = require('../../models/User');

// 1. INITIALIZE CLIENT (Global Config for OAuth)
const twitterClient = new TwitterApi({
  clientId: process.env.TWITTER_CLIENT_ID,
  clientSecret: process.env.TWITTER_CLIENT_SECRET,
});

// A temporary map to store 'state' (security check) vs 'userId'
// In production, use Redis or a DB table for this.
const stateCache = new Map();

// --- ROUTE A: START LOGIN (GET /api/auth/twitter/login) ---
const initTwitterLogin = async (req, res) => {
  const userId = req.user.id; // User must be logged in to Aura first

  // Generate the Auth Link
  const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
    'http://localhost:5000/api/v1/auth/twitter/callback', // Your Callback URL
    { scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] }
  );

  // Store the verifier & user ID temporarily
  stateCache.set(state, { codeVerifier, userId });

  // Send the URL to frontend so it can redirect the user
  res.json({ url });
};

// --- ROUTE B: CALLBACK (GET /api/auth/twitter/callback) ---
const twitterCallback = async (req, res) => {
  const { state, code } = req.query;

  const storedData = stateCache.get(state);
  if (!storedData) {
    return res.status(400).send('Invalid state or session expired.');
  }

  const { codeVerifier, userId } = storedData;

  try {
    // Exchange Code for Tokens
    const { accessToken, refreshToken, expiresIn } = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: 'http://localhost:5000/api/v1/auth/twitter/callback',
    });

    // Calculate Expiry (usually 2 hours from now)
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // SAVE TO DB
    await User.findByIdAndUpdate(userId, {
      $push: {
        connectedAccounts: {
          platformName: 'twitter',
          twitterAccessToken: accessToken,
          twitterRefreshToken: refreshToken, // CRITICAL: Used to get new access tokens later
          twitterExpiresAt: expiresAt
        }
      }
    });

    // Cleanup Cache
    stateCache.delete(state);

    // Redirect user back to Frontend Dashboard
    res.redirect('http://localhost:3000/dashboard?twitter=success');

  } catch (error) {
    console.error('Twitter Auth Failed:', error);
    res.status(500).send('Twitter connection failed.');
  }
};

module.exports = { initTwitterLogin, twitterCallback };