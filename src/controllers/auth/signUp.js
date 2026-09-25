const User = require("../../models/User");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const signup = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: "Email and Password are required",
    });
  }

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
    console.error("Signup error:", error);

    return res.status(500).json({
      message: "Server Error",
    });
  }
};

module.exports = signup;
