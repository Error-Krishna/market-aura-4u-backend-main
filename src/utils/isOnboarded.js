const User = require("../models/user"); // Assuming you have a User model


const isOnboarded = async (req, res, next) => {
  // 1. Get user ID from the request (attached by your auth middleware)
  const userId = req.user.id; 

  // 2. Fetch the REAL user status from DB
  const user = await User.findById(userId);

  // 3. Check if they skipped onboarding/setup
  // (Adjust the field name 'profileIncomplete' to match your DB schema)
  if (!user.isOnboarded) {
    return res.status(403).json({
      status: "fail",
      message: "⛔ Access Denied: Workspace setup required.",
      error_code: "WORKSPACE_LOCKED"
    });
  }

  // 4. If clean, proceed
  next();
};

module.exports = isOnboarded;