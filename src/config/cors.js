function readCorsOrigins(env = process.env) {
  const configured = env.CORS_ALLOWED_ORIGINS;
  if (configured === undefined) {
    if (env.NODE_ENV === 'production') {
      throw new Error('CORS_ALLOWED_ORIGINS is required in production');
    }
    return ['http://localhost:5173', 'http://127.0.0.1:5173'];
  }

  const origins = configured.split(',').map(value => value.trim());
  for (const origin of origins) {
    let parsed;
    try { parsed = new URL(origin); } catch {
      throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    }
    // Require canonical origins: no wildcards, paths, credentials, queries,
    // fragments, opaque origins or implicit normalization of a different value.
    if (origin.includes('*') || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    }
    if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      throw new Error('CORS_ALLOWED_ORIGINS must use HTTPS in production');
    }
  }
  return [...new Set(origins)];
}

module.exports = readCorsOrigins;
