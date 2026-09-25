const express = require('express');
const app = express();
const cookieParser = require("cookie-parser");
const dotenv = require('dotenv').config();
const port = process.env.PORT || 3000; // Added fallback port just in case
const connectDB = require('./config/db');
const User = require('./models/User');
const apiRouter = require("./routes");
const { instagramLogin, instagramCallback, publishImageToInstagram } = require("../src/controllers/auth/authController");
const cors = require('cors');

// ✅ CORS FIX: Allow dynamic origins (Friends, Postman, Localhost)
// app.use(cors({
//   origin: function (origin, callback) {
//     // Allow requests with no origin (like mobile apps, curl, or Postman)
//     if (!origin) return callback(null, true);
    
//     // Allow any origin (This lets your friend connect from their localhost)
//     return callback(null, true);
//   },
//   methods: ["GET", "POST", "PUT", "DELETE"],
//   credentials: true // Crucial for cookies
// }));

app.use(cors({
  origin: true, // <--- This allows your friend, localhost, and Postman dynamically
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true // This requires specific origin, 'true' handles it auto-magically
}));

app.use(express.json());
app.use(cookieParser());

// Mount your main API routes
app.use('/api', apiRouter);

// ✅ Publishing Route
app.post('/api/v1/publish/instagram', async (req, res) => {
  try {
    const { userId, imageUrl, caption } = req.body;
     console.log(req.body);
    // A. Find User in DB
    const user = await User.findById(userId);
    
    // B. Check connection
    if (!user || !user.socialAccounts?.instagram?.isConnected) {
      return res.status(400).json({ error: "User has not connected Instagram yet." });
    }

    const { instagramId, accessToken } = user.socialAccounts.instagram;

    // C. Publish using stored keys
    const result = await publishImageToInstagram(instagramId, accessToken, imageUrl, caption);
    
    res.json({ success: true, postId: result.id });

  } catch (error) {
    console.error(error); // Log error to terminal so you can see it
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, async () => {
  await connectDB();
  console.log(`Server is running at https://localhost:${port}`);
});