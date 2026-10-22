const USER_RESPONSE_FIELDS = [
  '_id', 'name', 'email', 'onboardingCompleted', 'isPremium', 'createdAt',
  'credits.monthly', 'credits.used',
  'brandProfile.companyName', 'brandProfile.industry', 'brandProfile.uvp',
  'brandProfile.targetAudience', 'brandProfile.marketingGoal',
  'brandProfile.brandVoice.tone', 'brandProfile.brandVoice.description', 'brandProfile.platforms',
].join(' ');
const allowedPlatforms = new Set(['twitter', 'linkedin', 'instagram', 'facebook', 'email', 'blog']);
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const nonnegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;

function onboardingUser(user) {
  const brand = user.brandProfile;
  const audience = typeof brand?.targetAudience === 'string'
    ? brand.targetAudience : brand?.targetAudience?.description;
  // Construct every nested object explicitly; never spread or serialize a model
  // document/subdocument, even when the query already uses a safe projection.
  return {
    id: String(user._id || user.id || ''), name: text(user.name), email: text(user.email),
    onboardingCompleted: user.onboardingCompleted === true,
    isPremium: user.isPremium === true,
    credits: {
      monthly: nonnegative(user.credits?.monthly, 100), used: nonnegative(user.credits?.used, 0),
    },
    brandProfile: {
      companyName: text(brand?.companyName), industry: text(brand?.industry), uvp: text(brand?.uvp),
      targetAudience: text(audience), marketingGoal: text(brand?.marketingGoal),
      brandVoice: {
        tone: text(brand?.brandVoice?.tone, 'Professional'),
        description: text(brand?.brandVoice?.description),
      },
      platforms: Array.isArray(brand?.platforms)
        ? [...new Set(brand.platforms.filter(value => allowedPlatforms.has(value)))] : [],
    },
  };
}

function profileData(user) {
  const safe = onboardingUser(user);
  const brand = safe.brandProfile;
  return {
    id: safe.id, name: safe.name, email: safe.email,
    isOnboarded: safe.onboardingCompleted, isPremium: safe.isPremium,
    // Keep the existing dashboard display rule and field name.
    isUserPremium: safe.isPremium || safe.credits.monthly > 100,
    joinedAt: user.createdAt instanceof Date && Number.isFinite(user.createdAt.valueOf())
      ? user.createdAt.toISOString() : undefined,
    credits: {
      total: safe.credits.monthly, used: safe.credits.used,
      remaining: Math.max(0, safe.credits.monthly - safe.credits.used),
    },
    companyName: brand.companyName, industry: brand.industry, uvp: brand.uvp,
    targetAudience: brand.targetAudience, marketingGoal: brand.marketingGoal,
    brandVoice: brand.brandVoice, platforms: brand.platforms,
  };
}

module.exports = { USER_RESPONSE_FIELDS, onboardingUser, profileData };
