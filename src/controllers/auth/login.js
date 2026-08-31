const User = require("../../models/user"); 
const bcrypt=require("bcrypt");
const jwt=require("jsonwebtoken");
async function login(req, res) {
  console.log("login comin g");
  const { email, password } = req.body;
  
  try {
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate Token
    const token = jwt.sign(
      { id: user._id, email: user.email }, 
      process.env.JWT_SECREAT_KEY,
      { expiresIn: '24h' }
    );

    // Set Cookie (for backend-to-backend/security)
    res.cookie("token", token, {
      // httpOnly: true,
      // secure: process.env.NODE_ENV === 'production', 
      // sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000
    });

     console.log(token);
    // Send JSON (for Frontend localStorage)
    res.status(200).json({
      message: "User logged in successfully",
      status: 200,
      token: token, // <--- IMPORTANT: Frontend interceptor needs this
      data: {
        id: user._id,
        email: user.email,
        isOnboarded:user.onboardingCompleted
        // add other non-sensitive fields if needed
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error" });
  }
}
module.exports=login;