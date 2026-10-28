const { validAuthBody } = require('../utils/authInput');
const { createAuthLimiter } = require('../utils/authLimiter');
const limiter = createAuthLimiter(require('../config/auth')());
const { createAuthClientIpResolver } = require('../utils/authClientIp');
const resolveClientIp = createAuthClientIpResolver(require('../config/authProxy')());

function reject(res, result) {
  res.set('Retry-After', String(result.retryAfter));
  return res.status(result.status).json({
    success: false, code: result.code,
    message: result.status === 429
      ? 'Too many authentication attempts. Please try again later.'
      : 'Authentication is temporarily at capacity. Please try again later.',
  });
}

function isAuthRequest(req) {
  return req.method === 'POST' && /^\/(login|signup)\/?$/i.test(req.path);
}

function limitAuthIp(req, res, next) {
  if (!isAuthRequest(req)) return next();
  const clientIp = resolveClientIp(req);
  if (!clientIp) {
    res.set('Retry-After', '1');
    return res.status(503).json({
      success: false, code: 'AUTH_CLIENT_IP_UNVERIFIED',
      message: 'Authentication client address could not be verified.',
    });
  }
  const result = limiter.consumeIp(clientIp);
  if (!result.allowed) return reject(res, result);
  return next();
}

function handleAuthPayloadError(error, req, res, next) {
  const onboarding = req.method === 'POST' && /^\/onboarding\/?$/i.test(req.path);
  if (!isAuthRequest(req) && !onboarding) return next(error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false, code: onboarding ? 'INVALID_ONBOARDING_INPUT' : 'INVALID_AUTH_INPUT',
      message: onboarding ? 'Send a valid JSON onboarding object.' : 'Send a valid JSON object with email and password.',
    });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false, code: onboarding ? 'ONBOARDING_PAYLOAD_TOO_LARGE' : 'AUTH_PAYLOAD_TOO_LARGE',
      message: onboarding ? 'Onboarding request body is too large.' : 'Authentication request body is too large.',
    });
  }
  return next(error);
}

function withAccountLimit(mode, handler) {
  return async (req, res) => {
    // The handler supplies the validation response; invalid payloads only spend
    // the IP budget and never allocate an account entry or start expensive work.
    if (!validAuthBody(req.body, mode)) return handler(req, res);
    const result = limiter.acquireAccount(req.body.email);
    if (!result.allowed) return reject(res, result);
    try {
      return await handler(req, res);
    } finally {
      // Do not release on socket close while bcrypt/database work continues.
      result.release();
    }
  };
}

module.exports = { limitAuthIp, handleAuthPayloadError, withAccountLimit };
