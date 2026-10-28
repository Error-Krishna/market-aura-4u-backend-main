const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { validAuthBody } = require('../../utils/authInput');
const { withAccountLimit } = require('../../middleware/authAttempts');

const signup = async (req, res) => {
  if (!validAuthBody(req.body, 'signup')) {
    return res.status(400).json({
      success: false, code: 'INVALID_AUTH_INPUT',
      message: 'Send only a valid email address and a password of at least 8 characters and at most 72 UTF-8 bytes. A password cannot contain only whitespace.',
    });
  }
  const { email, password } = req.body;

  try {
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({
        message: "User already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      email,
      password: hashedPassword,

      onboardingCompleted: false,
    });

    await user.save();

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

    return res.status(201).json({
      message: "User created successfully",
      status: 201,
      token,

      data: {
        id: user._id,
        email: user.email,

        isOnboarded: user.onboardingCompleted,

        isPremium: user.isPremium,
      },
    });
  } catch (error) {
    console.error('Signup failed');

    return res.status(500).json({
      message: "Server Error",
    });
  }
};

module.exports = withAccountLimit('signup', signup);
