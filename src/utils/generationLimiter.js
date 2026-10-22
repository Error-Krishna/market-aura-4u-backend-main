const { performance } = require('node:perf_hooks');

// Process-local protection. A shared atomic store is required before scaling
// across workers or instances; restarting this process resets its quotas.
function createGenerationLimiter({ maxRequests, windowMs, maxConcurrent, maxUsers,
  now = () => performance.now() }) {
  const users = new Map();
  for (const value of [maxRequests, windowMs, maxConcurrent, maxUsers]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid generation limits');
  }
  const denied = (code, retryAfter = 1, status = 429) => ({ allowed: false, code, retryAfter, status });
  const expire = (entry, time) => {
    entry.starts = entry.starts.filter(start => start > time - windowMs);
  };

  return {
    acquire(userId) {
      const key = String(userId);
      const time = now();
      let entry = users.get(key);
      if (!entry) {
        if (users.size >= maxUsers) {
          for (const [id, candidate] of users) {
            expire(candidate, time);
            if (candidate.active === 0 && candidate.starts.length === 0) users.delete(id);
          }
        }
        // Never evict a live quota or slot to make space for a new identity.
        if (users.size >= maxUsers) {
          return denied('GENERATION_CAPACITY', Math.ceil(windowMs / 1000), 503);
        }
        entry = { starts: [], active: 0 };
        users.set(key, entry);
      }
      expire(entry, time);
      if (entry.active >= maxConcurrent) return denied('GENERATION_IN_PROGRESS');
      if (entry.starts.length >= maxRequests) {
        return denied('GENERATION_RATE_LIMIT', Math.max(1,
          Math.ceil((entry.starts[0] + windowMs - time) / 1000)));
      }

      // No await between checking and reserving: concurrent requests cannot
      // acquire the same last slot. Failures still count toward request limits.
      entry.starts.push(time);
      entry.active++;
      let released = false;
      return {
        allowed: true,
        release() {
          if (!released) { entry.active--; released = true; }
        },
      };
    },
  };
}

module.exports = { createGenerationLimiter };
