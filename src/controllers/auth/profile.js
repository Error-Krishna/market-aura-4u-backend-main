const User = require('../../models/user'); 

const getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Fetch user
    const user = await User.findById(userId).select('-password');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // --- LOGIC EXTRACTION ---
    // 1. Get Brand Profile (Handle if empty)
    const brand = user.brandProfile || {};
    
    // 2. Get Credits (Fallback to defaults if missing)
    const userCredits = user.credits || { monthly: 100, used: 0 };
    
    // 3. Calculate Logic
    const remainingCredits = userCredits.monthly - userCredits.used;
    // Premium logic: Explicit flag OR dynamic check (e.g., if they have > 100 credits)
    const isPremium = user.isPremium || userCredits.monthly > 100; 

    res.status(200).json({
      success: true,
      data: {
        // --- Logic Fields ---
        id: user._id,
        isOnboarded: user.onboardingCompleted,
        isUserPremium: isPremium,
        joinedAt: user.createdAt,

        // --- Auth Fields ---
        name: user.name,
        email: user.email,

        // --- Usage Stats ---
        credits: {
          total: userCredits.monthly,
          used: userCredits.used,
          remaining: remainingCredits
        },

        // --- Brand Profile Data (Flattened for Frontend) ---
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

module.exports = getUserProfile ;