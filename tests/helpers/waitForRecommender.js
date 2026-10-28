const { performance } = require('node:perf_hooks');

// Model imports vary with host filesystem caches. This is a startup budget,
// separate from the application's inference deadline; every probe is bounded too.
async function waitForRecommender({ child, url, startupTimeoutMs = 60000, probeTimeoutMs = 1000, pollMs = 250 }) {
  const started = performance.now();
  let spawnFailed = false;
  const onError = () => { spawnFailed = true; };
  child.on('error', onError);
  try {
    while (performance.now() - started < startupTimeoutMs) {
      if (spawnFailed) throw new Error('[E2E] Python daemon could not be started.');
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('[E2E] Python daemon exited before becoming ready.');
      }
      const remaining = startupTimeoutMs - (performance.now() - started);
      if (remaining <= 0) break;
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(probeTimeoutMs, remaining))));
      try {
        const response = await fetch(url, { signal });
        if (response.ok) {
          const body = await response.json();
          signal.throwIfAborted();
          if (body.status === 'ok' && body.model_version === 'v1.0'
            && performance.now() - started < startupTimeoutMs
            && !spawnFailed && child.exitCode === null && child.signalCode === null) {
            return Math.round(performance.now() - started);
          }
        } else {
          await response.body?.cancel();
        }
      } catch {
        // Refused connections and incomplete/invalid health responses are not ready.
      }
      const pause = Math.min(pollMs, startupTimeoutMs - (performance.now() - started));
      if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
    }
    throw new Error(`[E2E] Python daemon failed to become ready within ${startupTimeoutMs}ms.`);
  } finally {
    child.removeListener('error', onError);
  }
}

module.exports = { waitForRecommender };
