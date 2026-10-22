const { BlockList, isIP } = require('node:net');

function normalizeIp(value) {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) return null;
  if (isIP(value) === 4) return value;
  let canonical;
  try { canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
  // IPv4 and IPv4-mapped IPv6 must spend the same quota, including hex forms.
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  }
  return canonical;
}

function createAuthClientIpResolver({ mode, cidrs }) {
  const trusted = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    trusted.addSubnet(address, Number(prefix), isIP(address) === 4 ? 'ipv4' : 'ipv6');
  }
  const isTrusted = address => trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');

  return function resolve(req) {
    let current = normalizeIp(req.socket?.remoteAddress);
    if (!current) return null;
    // Untrusted/direct peers cannot choose their quota via any HTTP header.
    if (mode === 'direct' || !isTrusted(current)) return current;
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded !== 'string' || forwarded.length > 4096) return null;
    const addresses = forwarded.split(',');
    if (addresses.length > 32) return null;
    // Walk from the actual peer toward the client and stop at the first
    // untrusted hop. Attacker-supplied prefixes to its left are ignored.
    for (let index = addresses.length - 1; index >= 0; index--) {
      if (!isTrusted(current)) return current;
      current = normalizeIp(addresses[index].trim());
      if (!current) return null;
    }
    // An all-trusted/missing chain provides no verified client boundary.
    return isTrusted(current) ? null : current;
  };
}

module.exports = { createAuthClientIpResolver, normalizeIp };
