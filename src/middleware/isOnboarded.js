const User = require("../models/User");

const isOnboarded = async (req, res, next) => {
  try {
    // auth middleware should attach the authenticated user
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized",
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    // IMPORTANT:
    // MongoDB/User model uses onboardingCompleted.
    if (!user.onboardingCompleted) {
      return res.status(403).json({
        status: "fail",
        message: "Workspace setup required.",
        error_code: "WORKSPACE_LOCKED",
      });
    }

    next();
  } catch (error) {
    console.error("Onboarding check error:", error);

    return res.status(500).json({
      status: "error",
      message: "Unable to verify onboarding status.",
    });
  }
};

module.exports = isOnboarded;