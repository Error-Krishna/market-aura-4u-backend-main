# Generation validation and limits

`POST /api/v1/content/generate` continues to require authentication and completed
onboarding. Send a JSON object containing only `prompt`. It must be a string with
at least 5 characters after trimming and at most 5000 UTF-16 code units before
trimming. The trimmed text is stored and sent to the generator. Unknown fields,
including client-supplied user IDs or platform overrides, return HTTP 400 with
`INVALID_GENERATION_INPUT`.

Saved brand context is checked before provider calls. Required company name,
industry, UVP and target audience must be nonempty strings. Context text fields
are limited to 5000 code units each. Optional voice fields must also be strings
within that limit. Legacy audience descriptions remain supported. Platforms must
be a unique list drawn from the existing User model enum; an empty or absent list
retains the Instagram/Twitter default. Invalid context returns HTTP 400 with
`INVALID_BRAND_PROFILE` and can be corrected through onboarding. No data is migrated.

## Configuration

These optional environment variables are read at process startup. Values must be
positive decimal integers within the ranges below; invalid values fail startup.

| Variable | Default | Maximum | Purpose |
| --- | ---: | ---: | --- |
| `GENERATION_MAX_REQUESTS` | 10 | 1000 | Admitted generations per user in the rolling window |
| `GENERATION_WINDOW_MS` | 60000 | 3600000 | Rolling request window in milliseconds |
| `GENERATION_MAX_CONCURRENT` | 1 | 10 | Active generations per user |
| `GENERATION_MAX_USERS` | 10000 | 100000 | Maximum entries in the process-local limiter |
| `GROQ_TIMEOUT_MS` | 45000 | 120000 | Groq fetch and response-body deadline in milliseconds |
| `GROQ_MAX_OUTPUT_TOKENS` | 1536 | 4096 | Maximum completion tokens per Groq request, including reasoning |

Existing explicit environment overrides still take precedence; update deployment
configuration to `GROQ_MAX_OUTPUT_TOKENS=1536` to use the verified MVP budget.
Credential values are unchanged. Each generation requests one completion
(`n: 1`), with no retries. A truncated (`finish_reason: length`) response fails
instead of being persisted as a successful generation.

## Generated output contract

Every requested platform must contain nonempty content. Twitter is a nonempty
array of objects with a `text` string of at most 280 Unicode code points.
LinkedIn, Facebook and Blog are nonempty arrays of nonblank strings. Email has
nonblank `subject` and `body` strings. Instagram requires a nonblank `caption`;
carousel slides are normalized to sequential numbers and capped at seven.
Supplied carousel arrays require at least three slides with nonblank headlines
and bodies (legacy nonblank slide strings are supported). Caption-based recovery
remains for responses that omit slides entirely. Partial or malformed supplied
slides are rejected. Unrequested platform and provider metadata keys are dropped.

Missing or malformed requested output fails the job and returns the existing
generation-error response; generic Twitter content is no longer invented.

The limiter uses the authenticated database account ID, so different sessions,
JWTs, cookies and bearer tokens for the same user share a quota. Request and brand
validation failures do not consume quota. Once admitted, failed generations count
too; repeatedly failing provider calls cannot bypass the request limit. Denied
requests never reach either provider or create a job.

HTTP 429 uses `GENERATION_RATE_LIMIT` or `GENERATION_IN_PROGRESS` and includes a
`Retry-After` header in seconds. For concurrency denials it is a suggested retry
delay, not a completion estimate. HTTP 503 with `GENERATION_CAPACITY` is returned
when the bounded registry is full; active entries and unexpired quotas are never
evicted to admit new users. Expired inactive entries are reclaimed as needed.

Slots are released in `finally` after provider and persistence work settles. A
client disconnect does not release a slot while the work continues. Groq deadline
expiry returns HTTP 504 with `GENERATION_TIMEOUT`; the existing recommender
deadline and ungrounded fallback remain. Failure-status writes are best effort,
so a database outage can leave a job marked processing, but cannot suppress the
error response once the database operation rejects. Database operations still
depend on the existing Mongoose timeouts.

## Deployment limitation

These limits are in memory, per Node process. A restart resets quotas; multiple
workers or Cloud Run instances each have their own limits. This is not a global
spending cap, monthly credit enforcement, or protection against multiple accounts.
Shared atomic enforcement and an aggregate provider budget are still required
before public scaling. No shared infrastructure or database changes are introduced
in this cycle.

## Tests

`node --test tests/generationSafety.test.js tests/generationLimiter.test.js tests/generationRoute.test.js`
runs offline validation, quota/expiry, concurrency, provider failure, timeout and
real Express-route tests with mocked persistence and providers. `npm test` also
runs the existing local Python recommender integration; Groq remains mocked.
