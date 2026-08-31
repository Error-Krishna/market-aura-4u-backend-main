const User = require("../../models/user"); 
const jwt = require('jsonwebtoken'); // 1. Import JWT
const bcrypt=require("bcrypt");
const signup = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and Password are required' });
  }

  try {
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    user = new User({
      email,
      password: hashedPassword
    });

    await user.save();

    // 5️⃣ Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECREAT_KEY,
      { expiresIn: '24h' }
    );

    // 6️⃣ Send cookie (Optional but good for security)
    res.cookie('token', token, {
      httpOnly: true, // Prevents XSS attacks
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    });

    // 7️⃣ Respond success (Include token for localStorage)
    res.status(201).json({ 
      message: 'User created successfully',
      status: 200,
      token, // Frontend needs this for localStorage
      data: { id: user._id, email: user.email }
    });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: 'Server Error' });
  }
};

module.exports = signup;