const User = require('../../models/User');

const getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select('-password');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const brand = user.brandProfile || {};

    const userCredits = user.credits || { monthly: 100, used: 0 };

    const remainingCredits = userCredits.monthly - userCredits.used;
    const isPremium = user.isPremium || userCredits.monthly > 100;

    res.status(200).json({
      success: true,
      data: {
        id: user._id,
        isOnboarded: user.onboardingCompleted,
        isUserPremium: isPremium,
        joinedAt: user.createdAt,

        name: user.name,
        email: user.email,

        credits: {
          total: userCredits.monthly,
          used: userCredits.used,
          remaining: remainingCredits
        },

        companyName: brand.companyName || "",
        industry: brand.industry || "",
        targetAudience: brand.targetAudience || "",
        marketingGoal: brand.marketingGoal || "",
        brandVoice: brand.brandVoice || { tone: 'Professional', description: '' },
        platforms: brand.platforms || []
      }
    });

  } catch (error) {
    console.error('Get Profile Error:', error.message);
    res.status(500).json({ success: false, message: 'Server Error', error: error.message });
  }
};

module.exports = getUserProfile;