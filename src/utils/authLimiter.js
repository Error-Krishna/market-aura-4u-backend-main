const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

function createAuthLimiter({ windowMs, maxIpAttempts, maxAccountAttempts,
  maxConcurrent, maxTrackedKeys, now = () => performance.now() }) {
  for (const value of [windowMs, maxIpAttempts, maxAccountAttempts, maxConcurrent, maxTrackedKeys]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid authentication limits');
  }
  let active = 0;
  const denied = (status, code, retryAfter = 1) => ({ allowed: false, status, code, retryAfter });

  function registry(maxAttempts) {
    const entries = new Map();
    return identity => {
      // Bound retained data and avoid storing raw email/IP values in the limiter.
      const key = createHash('sha256').update(identity).digest('hex');
      const time = now();
      const expire = starts => starts.filter(start => start > time - windowMs);
      if (!entries.has(key) && entries.size >= maxTrackedKeys) {
        for (const [id, starts] of entries) {
          const remaining = expire(starts);
          if (remaining.length === 0) entries.delete(id);
          else entries.set(id, remaining);
        }
      }
      if (!entries.has(key) && entries.size >= maxTrackedKeys) {
        return denied(503, 'AUTH_CAPACITY', Math.ceil(windowMs / 1000));
      }
      const starts = expire(entries.get(key) || []);
      entries.set(key, starts);
      if (starts.length >= maxAttempts) {
        return denied(429, 'AUTH_ATTEMPT_LIMIT', Math.max(1,
          Math.ceil((starts[0] + windowMs - time) / 1000)));
      }
      starts.push(time);
      return { allowed: true };
    };
  }

  const consumeIp = registry(maxIpAttempts);
  const consumeAccount = registry(maxAccountAttempts);
  return {
    consumeIp,
    acquireAccount(email) {
      if (active >= maxConcurrent) return denied(503, 'AUTH_CAPACITY');
      const result = consumeAccount(email.toLowerCase());
      if (!result.allowed) return result;
      active++;
      let released = false;
      return {
        allowed: true,
        release() {
          if (!released) { active--; released = true; }
        },
      };
    },
  };
}

module.exports = { createAuthLimiter };
