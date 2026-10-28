const User = require("../../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { validAuthBody } = require('../../utils/authInput');
const { withAccountLimit } = require('../../middleware/authAttempts');

async function login(req, res) {

  if (!validAuthBody(req.body, 'login')) {
    return res.status(400).json({
      success: false, code: 'INVALID_AUTH_INPUT',
      message: 'Send only a valid email address and a nonempty password of at most 4096 UTF-8 bytes.',
    });
  }
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
      },
      process.env.JWT_SECREAT_KEY,
      {
        expiresIn: "24h",
      },
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      message: "User logged in successfully",
      status: 200,
      token,

      data: {
        id: user._id,
        email: user.email,

        // Database field → frontend field
        isOnboarded: user.onboardingCompleted,

        isPremium: user.isPremium,
      },
    });
  } catch (error) {
    console.error('Login failed');

    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
}

module.exports = withAccountLimit('login', login);
