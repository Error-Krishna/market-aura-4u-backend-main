# Verified authentication client IPs

Only authentication-attempt IP selection changes. Express's global `trust proxy`
remains disabled, so forwarded Host/Proto headers do not change application trust.
No deployment topology has been verified by these local tests.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_PROXY_MODE` | `direct` | `direct` or `trusted-cidrs` |
| `AUTH_TRUSTED_PROXY_CIDRS` | empty | At most 64 comma-separated explicit IPv4/IPv6 subnets for known proxies |

In direct mode, all forwarding headers are ignored. In trusted-cidrs mode, only a
socket peer in the configured proxy ranges may supply `X-Forwarded-For`. The chain
is traversed right-to-left through known proxies, stopping at the nearest untrusted
address. Forged prefixes beyond that boundary are ignored. `Forwarded`, X-Real-IP,
forwarded host and forwarded protocol are not authentication identity sources.
Equivalent IPv6 spellings and IPv4-mapped addresses normalize to one quota key.

Trusted peers with no usable client boundary receive HTTP 503,
`AUTH_CLIENT_IP_UNVERIFIED`, and `Retry-After: 1` before JSON parsing/account work.
Malformed trusted-chain addresses, scoped/port-bearing addresses, all-trusted
chains, lists over 32 entries, and headers over 4096 characters fail closed. Raw
headers and request bodies are not echoed. Health and logout remain unaffected.
Untrusted socket peers continue to use their actual IP, ignoring supplied headers.

Configuration rejects blanket `/0` entries, hostname aliases, hop-count settings,
unknown modes, missing lists in trusted mode and lists supplied in direct mode.
Use ordinary IPv4 CIDRs for IPv4-mapped peers. On Cloud Run (`K_SERVICE` is set),
`AUTH_PROXY_MODE` must be set explicitly; leaving it unset still fails startup.

## Cloud Run peer-IP fallback

Set `AUTH_PROXY_MODE=direct` explicitly and leave `AUTH_TRUSTED_PROXY_CIDRS`
empty. This permits startup without undocumented platform proxy CIDRs. Only the
normalized socket peer is used; all forwarding headers, including malformed,
oversized or multi-hop chains, are ignored. Express global proxy trust remains
disabled. An absent or invalid socket address still fails closed with HTTP 503.
Other startup requirements, including private recommender configuration, remain
unchanged. No Cloud Run service or ingress topology is verified by these tests.

The peer can be a platform proxy, so unrelated users can share one IP budget
(default 30 attempts per 15 minutes). This deliberately favors bounded work over
precise browser-IP isolation: changing a forwarded address cannot create a new
budget, but one caller can temporarily exhaust the shared peer budget and deny
other users login/registration attempts. Different peers can have different
budgets; this is not a global request cap. Per-account attempt limits, process-wide
active-work limits and bounded registries remain enforced. Do not raise limits
or trust arbitrary headers to compensate for this tradeoff.

For the limited pilot, use one Node process, a service-level maximum of one
instance and one serving revision, with bounded request concurrency. Local
quotas reset on restart, and each instance/revision has independent state;
Cloud Run can temporarily exceed an instance target. This is not a durable,
cross-instance quota or a spending ceiling. No shared limiter or infrastructure
is introduced by this fallback.

Before enabling trusted mode in a deployment:

1. Verify the actual proxy chain and which trusted hop appends or replaces client
   addresses, including traffic through the default Cloud Run URL and any gateway.
2. Configure only those proxy CIDRs. Do not trust all private ranges or assume a
   hop count or client-controlled leftmost forwarding value is authentic.
3. Restrict ingress to the intended trusted path. A CIDR is an address range, not
   cryptographic proof of a proxy's identity; prevent other tenants/clients from
   reaching the app from the same trusted range.
4. Confirm distinct clients get distinct quotas and forged prefixes cannot rotate
   them. Keep activation blocked if the real Cloud Run topology cannot be proven.

This change alters only the application's explicit Cloud Run startup policy,
not ingress, network policy, or any deployed service. Shared quota storage is
separately pending the database approval described in [the proposal](shared-limits-proposal.md).

Reference: [Express guidance for proxy trust](https://expressjs.com/en/guide/behind-proxies/).

Offline regression command:
`node --test tests/authProxy.test.js tests/authProxyFallback.test.js tests/authRoutes.test.js tests/authLimiter.test.js`

Tests use synthetic addresses and local HTTP with mocked account operations.
