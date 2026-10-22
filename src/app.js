const express = require('express');
const app = express();
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
if (require.main === module) require('dotenv').config();
const port = process.env.PORT || 3000;
const connectDB = require('./config/db');
const apiRouter = require('./routes');
const createCorsMiddleware = require('./middleware/cors');
const { limitAuthIp, handleAuthPayloadError } = require('./middleware/authAttempts');

app.use(createCorsMiddleware());
app.use('/api/v1/auth', limitAuthIp);

app.use(express.json());
app.use('/api/v1/auth', handleAuthPayloadError);
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

app.get('/ready', (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'not_ready', dependencies: { database: 'unavailable' } });
  }
  return res.status(200).json({ status: 'ready' });
});

app.use('/api', apiRouter);

if (require.main === module) {
  app.listen(port, async () => {
    await connectDB();
    console.log(`Server is running at https://localhost:${port}`);
  });
}

module.exports = app;
