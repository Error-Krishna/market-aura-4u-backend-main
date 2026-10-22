const cors = require('cors');
const readCorsOrigins = require('../config/cors');

function createCorsMiddleware(env = process.env) {
  const allowedOrigins = new Set(readCorsOrigins(env));
  const allowCors = cors({
    origin: [...allowedOrigins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Retry-After'],
  });

  return (req, res, next) => {
    // All variants, including denied and no-Origin requests, vary by Origin.
    res.vary('Origin');
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    if (!allowedOrigins.has(origin)) {
      // Merely omitting CORS headers still runs route handlers. Reject before
      // parsing the body, looking up accounts or causing provider side effects.
      return res.status(403).json({
        success: false, code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed.',
      });
    }
    return allowCors(req, res, next);
  };
}

module.exports = createCorsMiddleware;
