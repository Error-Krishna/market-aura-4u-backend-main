const express = require('express');
const app = express();
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv').config();
const port = process.env.PORT || 3000;
const connectDB = require('./config/db');
const User = require('./models/User');
const apiRouter = require('./routes');
const { publishImageToInstagram } = require('./controllers/auth/authController');
const cors = require('cors');

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

app.use('/api', apiRouter);

app.post('/api/v1/publish/instagram', async (req, res) => {
  try {
    const { userId, imageUrl, caption } = req.body;
    const user = await User.findById(userId);

    if (!user || !user.socialAccounts?.instagram?.isConnected) {
      return res.status(400).json({ error: 'User has not connected Instagram yet.' });
    }

    const { instagramId, accessToken } = user.socialAccounts.instagram;

    const result = await publishImageToInstagram(
      instagramId,
      accessToken,
      imageUrl,
      caption
    );

    res.json({ success: true, postId: result.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, async () => {
  await connectDB();
  console.log(`Server is running at https://localhost:${port}`);
});
