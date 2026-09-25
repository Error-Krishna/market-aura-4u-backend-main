const User = require("../../models/User");

const completeOnboarding = async (req, res) => {
  // 1. GET DATA FROM FRONTEND
  // Make sure your frontend form sends these exact names
  const { 
    companyName, 
    industry, 
    brandTone, 
    uvp,            
    targetAudience,  
    platforms 
  } = req.body;
  
  const userId = req.user.id;

  try {
    // 2. PREPARE THE UPDATE OBJECT
    // We must nest the data inside "brandProfile" to match your Schema
    const updates = {
      
      // This stays at the Root Level
      onboardingCompleted: true,

      // Everything else goes inside the nested object
      brandProfile: {
        companyName: companyName || '',
        industry: industry || '',
        
        // The "Brain" of your AI
        uvp: uvp || '', 
        targetAudience: targetAudience || '', 
        
        brandVoice: {
          tone: brandTone || 'Professional',
          description: '' // You can add a text input for this later
        },
        
        // Ensure this is an array like ["twitter", "linkedin"]
        platforms: platforms || [] 
      }
    };

    // 3. UPDATE DATABASE
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updates }, // Use $set to be safe with nested updates
      { new: true, runValidators: true }
    ).select('-password');

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // 4. SUCCESS RESPONSE
    res.status(200).json({
      success: true,
      message: 'Onboarding completed successfully',
      user: updatedUser
    });

  } catch (error) {
    console.error("Onboarding Error:", error);
    res.status(500).json({ 
      success: false, 
      message: 'Server Error during onboarding', 
      error: error.message 
    });
  }
};

module.exports = completeOnboarding;