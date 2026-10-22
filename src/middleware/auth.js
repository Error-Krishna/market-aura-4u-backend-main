const jwt = require('jsonwebtoken');
const userModel = require('../models/User');

const verify = async (req, res, next) => {
  let token;
  try {
    token = req.cookies.token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

  } catch (err) {
    console.error('Auth Error:', err.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECREAT_KEY);
  } catch (err) {
    console.error('Auth Error:', err.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  let user;
  try {
    user = await userModel.findOne({ email: decoded.email });
  } catch (err) {
    console.error('Authentication account lookup failed');
    return res.status(503).json({
      success: false,
      code: 'AUTH_DEPENDENCY_UNAVAILABLE',
      message: 'Authentication is temporarily unavailable',
    });
  }

  if (!user) {
    return res.status(401).send('User not found');
  }

  req.user = user;
  return next();
};

module.exports = verify;
