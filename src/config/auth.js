function readAuthConfig(env = process.env) {
  function integer(name, fallback, maximum) {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!/^\d+$/.test(env[name]) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
    return value;
  }
  return {
    windowMs: integer('AUTH_WINDOW_MS', 900000, 3600000),
    maxIpAttempts: integer('AUTH_MAX_IP_ATTEMPTS', 30, 1000),
    maxAccountAttempts: integer('AUTH_MAX_ACCOUNT_ATTEMPTS', 10, 1000),
    maxConcurrent: integer('AUTH_MAX_CONCURRENT', 4, 32),
    maxTrackedKeys: integer('AUTH_MAX_TRACKED_KEYS', 10000, 100000),
  };
}

module.exports = readAuthConfig;
