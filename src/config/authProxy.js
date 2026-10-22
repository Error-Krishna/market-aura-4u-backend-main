const { isIP } = require('node:net');

function readAuthProxyConfig(env = process.env) {
  const mode = env.AUTH_PROXY_MODE ?? 'direct';
  if (!['direct', 'trusted-cidrs'].includes(mode)) {
    throw new Error('AUTH_PROXY_MODE must be direct or trusted-cidrs');
  }
  const input = env.AUTH_TRUSTED_PROXY_CIDRS ?? '';
  const cidrs = input.trim() === '' ? [] : input.split(',').map(value => value.trim());
  if (mode === 'direct' && cidrs.length > 0) {
    throw new Error('AUTH_TRUSTED_PROXY_CIDRS requires trusted-cidrs mode');
  }
  if (mode === 'trusted-cidrs' && (cidrs.length === 0 || cidrs.length > 64)) {
    throw new Error('AUTH_TRUSTED_PROXY_CIDRS requires between 1 and 64 explicit IP subnets');
  }
  for (const cidr of cidrs) {
    const parts = cidr.split('/');
    const family = isIP(parts[0]);
    const prefix = Number(parts[1]);
    if (parts.length !== 2 || !family || !/^\d+$/.test(parts[1])
      || !Number.isInteger(prefix) || prefix < 1 || prefix > (family === 4 ? 32 : 128)
      || parts[0].includes('%')
      || (family === 6 && new URL(`http://[${parts[0]}]/`).hostname.startsWith('[::ffff:'))) {
      throw new Error('AUTH_TRUSTED_PROXY_CIDRS must contain explicit IPv4/IPv6 CIDRs; /0, aliases and scoped/mapped addresses are unsupported');
    }
  }
  // On Cloud Run, direct mode deliberately shares the socket peer's budget.
  // Require explicit selection so deployment cannot silently assume browser-IP
  // isolation. Forwarded headers remain untrusted; no platform CIDRs are guessed.
  if (env.K_SERVICE && env.AUTH_PROXY_MODE === undefined) {
    throw new Error('Cloud Run requires explicit AUTH_PROXY_MODE=direct for shared peer-IP limits or trusted-cidrs with verified proxy CIDRs');
  }
  return { mode, cidrs: [...new Set(cidrs)] };
}

module.exports = readAuthProxyConfig;
