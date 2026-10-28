function readGenerationConfig(env = process.env) {
  function positiveInteger(name, fallback, maximum) {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!/^\d+$/.test(env[name]) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
    return value;
  }
  return {
    maxRequests: positiveInteger('GENERATION_MAX_REQUESTS', 10, 1000),
    windowMs: positiveInteger('GENERATION_WINDOW_MS', 60000, 3600000),
    maxConcurrent: positiveInteger('GENERATION_MAX_CONCURRENT', 1, 10),
    maxUsers: positiveInteger('GENERATION_MAX_USERS', 10000, 100000),
    groqTimeoutMs: positiveInteger('GROQ_TIMEOUT_MS', 45000, 120000),
    groqMaxOutputTokens: positiveInteger('GROQ_MAX_OUTPUT_TOKENS', 1536, 4096),
  };
}

module.exports = readGenerationConfig;
