const IDENTITY_ENDPOINT = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

function authError() {
  const error = new Error('Recommender authentication unavailable');
  error.code = 'RECOMMENDER_AUTH_UNAVAILABLE';
  return error;
}

function createRecommenderClient(config, {
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutSignal = ms => AbortSignal.timeout(ms),
} = {}) {
  return async function recommend(payload) {
    // One total budget for identity acquisition, inference and response parsing.
    const signal = timeoutSignal(config.timeoutMs);
    let acquiringIdentity = config.authMode === 'cloud-run';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (acquiringIdentity) {
        const identityUrl = new URL(IDENTITY_ENDPOINT);
        identityUrl.searchParams.set('audience', config.audience);
        const identity = await fetchImpl(identityUrl.href, {
          method: 'GET', headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal,
        });
        if (!identity.ok || identity.headers.get('Metadata-Flavor') !== 'Google') {
          await identity.body?.cancel();
          throw authError();
        }
        const token = (await identity.text()).trim();
        // Tokens come only from the fixed Google metadata endpoint. These
        // checks catch invalid/expired/wrong-audience responses before sending;
        // Google Cloud Run performs cryptographic verification at the receiver.
        if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
          throw authError();
        }
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        if (claims?.aud !== config.audience || !Number.isFinite(claims?.exp) || claims.exp * 1000 <= Date.now()) {
          throw authError();
        }
        headers.Authorization = `Bearer ${token}`;
      }
      // A late identity response must never start a request after the deadline.
      signal.throwIfAborted();
      acquiringIdentity = false;
      const response = await fetchImpl(config.recommend, {
        method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal,
      });
      const data = response.ok ? await response.json() : null;
      if (!response.ok) await response.body?.cancel();
      signal.throwIfAborted();
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      // Never surface SDK/fetch errors or response bodies, which may contain
      // identity credentials. Preserve safe timeout classification for fallback.
      if (signal.aborted || error?.name === 'TimeoutError') throw new DOMException('Recommender request timed out', 'TimeoutError');
      if (acquiringIdentity) throw authError();
      throw new Error('Recommender service unavailable');
    }
  };
}

module.exports = { createRecommenderClient };
