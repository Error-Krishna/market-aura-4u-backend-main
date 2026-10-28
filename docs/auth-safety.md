# Authentication validation and attempt limits

`POST /api/v1/auth/signup` and `POST /api/v1/auth/login` accept only a JSON object
with exactly two string fields: `email` and `password`. Unknown fields, objects,
arrays, nulls and missing values are rejected with HTTP 400 and
`INVALID_AUTH_INPUT` before account lookup, bcrypt or JWT signing.

Email addresses must match the ordinary ASCII email form supported by this app,
with at most 254 characters overall and 64 in the local part. Surrounding
whitespace and control characters are rejected. Email case is preserved for
storage and lookup, retaining the existing database behavior. No normalization,
user migration or changes to existing password hashes are performed.

New passwords must have at least eight JavaScript string code units (matching
the existing frontend minimum), contain something besides whitespace, and fit
within 72 UTF-8 bytes. Bcrypt ignores bytes after that boundary, so oversized new
passwords are rejected rather than silently truncated. Passwords are never trimmed.
Login accepts nonempty password strings up to 4096 UTF-8 bytes so existing short
or historically truncated passwords retain their bcrypt verification behavior.

Valid success responses, JWT contents/24-hour expiry, bcrypt hash cost 10 and
cookie attributes are unchanged. Unknown login accounts and incorrect passwords
still receive the same invalid-credentials response; existing signup accounts
retain the existing rejection response. This cycle adds no account lock field,
password reset flow or persistent lockout.

## Bounded attempt budgets

These optional settings are read at startup. They must be positive decimal
integers within the indicated maximum; invalid settings fail startup.

| Variable | Default | Maximum | Purpose |
| --- | ---: | ---: | --- |
| `AUTH_WINDOW_MS` | 900000 | 3600000 | Rolling attempt window in milliseconds |
| `AUTH_MAX_IP_ATTEMPTS` | 30 | 1000 | Requests per source peer IP per window |
| `AUTH_MAX_ACCOUNT_ATTEMPTS` | 10 | 1000 | Valid-shaped attempts per email per window |
| `AUTH_MAX_CONCURRENT` | 4 | 32 | Active credential checks across the process |
| `AUTH_MAX_TRACKED_KEYS` | 10000 | 100000 | Entries in each of the IP and email registries |

Login and signup share both budgets. Email quota keys are case-insensitive SHA-256
digests; source-IP keys are also hashed. Raw emails/IPs and passwords are not
retained in the limiter tables. Hashes are internal keys, not an anonymity guarantee.
Failed and successful attempts both count; successes do not reset counters.

IP requests are counted before JSON parsing, so malformed and oversized payloads
also spend the IP budget. The existing Express JSON body limit is 100 KiB. Bad
credential JSON receives a generic 400 response; oversized bodies receive HTTP 413
with `AUTH_PAYLOAD_TOO_LARGE`. Malformed/oversized-body errors on these two routes
and authentication exceptions do not echo or log the credential payload. Invalid payloads do not
allocate an email quota entry or reach bcrypt/database work.

Once shape validation passes, email admission and active-slot reservation happen
synchronously before lookup/hash/compare/write. HTTP 429 with `AUTH_ATTEMPT_LIMIT`
denies exhausted attempt budgets. A full bounded registry or active-check pool
returns HTTP 503 with `AUTH_CAPACITY`. Both responses include `Retry-After` seconds
and perform no account or password work. Denied IP attempts do not extend the
window; concurrency denials do not consume the email quota. Previously admitted
attempts retain their quota even if database or bcrypt work fails.

Slots release in `finally` when work settles, including failures, not when a
client disconnects while work continues. Stalled database work can occupy a slot
until the existing database timeout settles; no new unbounded queue is added.
Registries reclaim expired entries at capacity and never evict unexpired quotas
to make room for new identities. Health, logout and other routes are unaffected
by an exhausted authentication budget.

## Deployment limitations

Limits are per Node process and reset on restart. Multiple workers/instances have
independent budgets. Shared atomic enforcement remains necessary before public
scaling. Email throttling can temporarily affect a legitimate user whose email
is targeted; the rolling expiry bounds that effect without writing a permanent
account lock.

Source IP defaults to the normalized socket address; direct clients cannot rotate
arbitrary forwarding headers to evade the limit. Explicit verified-proxy CIDRs
can enable bounded right-to-left client-IP resolution for authentication only.
See [proxy configuration](auth-proxy.md) for fail-closed behavior and deployment
verification requirements. Express global `trust proxy` remains disabled; CORS
rejection still happens before authentication admission.

Shared storage is not implemented or enabled: the dedicated collection/index
requires approval. See the [concrete database proposal](shared-limits-proposal.md).

## Regression tests

```bash
node --test tests/authValidation.test.js tests/authLimiter.test.js tests/authRoutes.test.js
npm test
```

Tests cover validation, byte boundaries, quota expiry and capacity, shared budgets,
spoofed forwarding headers, concurrent work, failures and successful JWT/cookie
contracts. HTTP tests use the actual application on loopback with database,
password operations and external calls mocked. No real user data is changed.

The full test command serializes test files to reduce startup contention while
the existing Python integration loads its model. Its 25-second startup deadline
and assertions are unchanged. Concurrency tests within each file still explicitly
overlap requests and verify the active-work bounds.
