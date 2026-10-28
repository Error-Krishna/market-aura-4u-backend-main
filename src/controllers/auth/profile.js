const User = require('../../models/User');
const { USER_RESPONSE_FIELDS, profileData } = require('../../utils/userResponse');

const getUserProfile = async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const user = await User.findById(req.user.id).select(USER_RESPONSE_FIELDS);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({ success: true, data: profileData(user) });
  } catch {
    console.error('Profile lookup failed');
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

module.exports = getUserProfile;
