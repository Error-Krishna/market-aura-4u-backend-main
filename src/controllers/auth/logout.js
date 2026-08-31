function logout(req, res) {
  // Assuming you are using JWT stored in cookies for authentication
  res.clearCookie('token'); // Clear the token cookie
  return res.status(200).json({ message: 'user Logged out successfully' });
}

module.exports = logout;
