function readRecommenderConfig(env = process.env) {
  function endpoint(value, name) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`);
    }
    return url;
  }

  const recommend = endpoint(env.RECOMMENDER_URL || 'http://localhost:8001/recommend', 'RECOMMENDER_URL');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(recommend.hostname);
  const authMode = env.RECOMMENDER_AUTH_MODE || (loopback ? 'none' : 'cloud-run');
  if (!['none', 'cloud-run'].includes(authMode)) {
    throw new Error('RECOMMENDER_AUTH_MODE must be none or cloud-run');
  }
  let audience = null;
  if (authMode === 'none') {
    if (!loopback || env.K_SERVICE) {
      throw new Error('Unauthenticated recommender access is allowed only for local loopback development');
    }
    if (env.RECOMMENDER_AUDIENCE) {
      throw new Error('RECOMMENDER_AUDIENCE requires cloud-run authentication');
    }
  } else {
    audience = env.RECOMMENDER_AUDIENCE || recommend.origin;
    const audienceUrl = endpoint(audience, 'RECOMMENDER_AUDIENCE');
    // The MVP uses the canonical Cloud Run service URL, not a traffic-tag URL
    // or custom audience. Never send a service token to a different origin.
    if (recommend.protocol !== 'https:' || audienceUrl.origin !== audience
      || audienceUrl.origin !== recommend.origin || !audienceUrl.hostname.endsWith('.run.app')) {
      throw new Error('Cloud Run recommender requires HTTPS and a matching canonical run.app service-origin audience');
    }
  }
  const health = endpoint(env.RECOMMENDER_HEALTH_URL || new URL('/health', recommend).href, 'RECOMMENDER_HEALTH_URL');
  if (health.origin !== recommend.origin) {
    throw new Error('RECOMMENDER_HEALTH_URL must use the same origin as RECOMMENDER_URL');
  }
  // Remote scale-to-zero requests include cold startup (measured at ~72s).
  // Explicit overrides remain authoritative; local development stays fast.
  const timeout = env.RECOMMENDER_TIMEOUT_MS ?? (authMode === 'cloud-run' ? '120000' : '15000');
  const timeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('RECOMMENDER_TIMEOUT_MS must be an integer between 1 and 120000');
  }
  return { recommend: recommend.href, health: health.href, timeoutMs, authMode, audience };
}

module.exports = readRecommenderConfig;
