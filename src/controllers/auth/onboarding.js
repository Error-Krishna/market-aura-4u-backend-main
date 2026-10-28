const User = require('../../models/User');
const { parseOnboardingBody } = require('../../utils/onboardingInput');
const { USER_RESPONSE_FIELDS, onboardingUser } = require('../../utils/userResponse');

const completeOnboarding = async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const profile = parseOnboardingBody(req.body);
  if (!profile) {
    return res.status(400).json({
      success: false, code: 'INVALID_ONBOARDING_INPUT',
      message: 'Provide company name, industry, brand tone, UVP, target audience and at least one unique supported platform. Text fields must be nonblank strings of at most 5000 characters.',
    });
  }

  try {
    // One atomic write marks completion only with validated context. Dot paths
    // preserve other brand settings and never accept account/privilege overrides.
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { $set: {
        onboardingCompleted: true,
        'brandProfile.companyName': profile.companyName,
        'brandProfile.industry': profile.industry,
        'brandProfile.uvp': profile.uvp,
        'brandProfile.targetAudience': profile.targetAudience,
        'brandProfile.brandVoice.tone': profile.brandVoice.tone,
        'brandProfile.platforms': profile.platforms,
      } },
      { new: true, runValidators: true },
    ).select(USER_RESPONSE_FIELDS);

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({
      success: true, message: 'Onboarding completed successfully', user: onboardingUser(updatedUser),
    });
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({
        success: false, code: 'INVALID_ONBOARDING_INPUT', message: 'Invalid onboarding fields.',
      });
    }
    console.error('Onboarding failed');
    return res.status(500).json({ success: false, message: 'Server Error during onboarding' });
  }
};

module.exports = completeOnboarding;
