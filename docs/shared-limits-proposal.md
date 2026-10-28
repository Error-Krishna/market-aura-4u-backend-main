# Shared request limits: storage approval required

Status: design only. No collection, index, database command, migration, or shared
limiter has been added or activated. The current limiters are still process-local.

The existing project rules require approval before database schema/index changes.
Adding cross-instance state to User or Job would also change their schemas and
mix temporary security state with user/content data. A dedicated collection in
the existing application database is the smallest storage change; no additional
Redis service or cloud infrastructure is proposed.

## Proposed database change for approval

Collection: `market_aura_request_limits`, separate from Users and Jobs.

| Field | Proposed contents |
| --- | --- |
| `_id` | Versioned namespace plus SHA-256 identity digest, or a reserved global-capacity key |
| `version` | State format version, initially 1 |
| `starts` | Bounded admission timestamps for the existing rolling request window |
| `leases` | Bounded unique lease IDs, owner IDs and expiry/deadline timestamps for admitted work |
| `expireAt` | Cleanup date, never earlier than the quota window or active lease lifetime |

Raw email addresses, IP addresses, passwords, JWTs, provider credentials, prompts,
and generated content must not be stored in this collection. Identity hashes
are internal identifiers, not an anonymity guarantee.

Indexes: the automatic unique `_id` index and one proposed TTL index
`{ expireAt: 1 }` with `expireAfterSeconds: 0`. TTL deletion is asynchronous;
authorization and quota decisions must explicitly evaluate expiry and must not
depend on the TTL monitor having removed a document. No User/Job indexes change.

## Required implementation behavior

1. Share authentication IP/email quotas, the global authentication work limit,
   per-user generation quotas/concurrency, and registry capacity across all Node
   workers and instances. Preserve current response codes and Retry-After values.
2. Use atomic MongoDB admission with server time. Cross-document admission and
   capacity bookkeeping must be transactional, including concurrent first-use
   upserts and expired-key reclamation. Shared mode consequently requires a
   replica set; test against a disposable local replica set before Atlas use.
3. Reserve auth capacity before consuming an email attempt, preserving existing
   semantics for concurrency denials. IP requests still count before parsing.
   Admitted provider failures still consume the generation request quota.
4. Bound both documents and per-document arrays. TTL cleanup must not corrupt
   capacity bookkeeping or free active leases; use safe reclamation rather than
   treating deletion counts or in-memory counters as authoritative cluster state.
5. Release only the reservation's unique lease, idempotently, after work settles.
   A stale worker must never release a newer worker's lease. Define a bounded
   end-to-end work deadline before reclaiming crash-expired leases; do not expire
   concurrency merely because the rate window elapsed. Deadline/cancellation and
   lease recovery must be tested together to avoid overlapping provider work.
6. Fail closed with a generic 503 if shared state is unavailable, without starting
   bcrypt or provider work. Never fall back to independent memory budgets.
7. Keep explicit memory mode for offline/local compatibility. Cloud Run must
   require shared mode at startup. No application startup should create indexes
   or silently migrate state; activation follows an explicit approved setup step.

## Verification required after approval

- Independent clients/processes share rolling budgets and concurrent leases.
- Simultaneous first use and overlapping admissions cannot over-admit.
- Isolation between users/IPs, case-insensitive email quotas, quota expiry,
  duplicate/stale release, crash recovery, registry capacity and store outages.
- Real Express denial paths stop before account/password/provider work and retain
  the existing authentication and generation response contracts.
- A disposable local MongoDB replica set verifies actual transaction/TTL behavior;
  mocked tests alone cannot establish cross-process atomicity.

Approval sought: add this dedicated limiter collection and its TTL index to the
implementation, with initial verification confined to a disposable local MongoDB
replica set. This does not authorize Atlas access, production-data changes,
deployment, billing, committing, pushing, or provisioning cloud resources.
