function logout(req, res) {
  res.clearCookie('token');
  return res.status(200).json({ message: 'user Logged out successfully' });
}

module.exports = logout;
