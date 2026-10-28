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

## Internal failure diagnostics

Failures emit a JSON `generation_failure` event to stderr. Correlate its `jobId`
with the saved job and Cloud Run request timestamp. `stage` and `category` are
fixed internal values distinguishing user lookup, job creation, prompt preparation,
provider HTTP/transport/body errors, empty/truncated/unparseable/invalid output,
and completion or failure-status database writes. Provider deadline failures use
`PROVIDER_TIMEOUT`.

Events include elapsed milliseconds and, when available, provider HTTP status,
an allowlisted finish reason, and nonnegative integer prompt/completion/total and
reasoning token counts. Unknown finish reasons become `other`. Exceptions,
provider bodies, prompts, generated text, credentials, URLs, and arbitrary provider
metadata are never copied into these events. A failed failure-status write emits
a second event without replacing the original public error.

Public responses and saved job errors retain their existing generic messages.
Token counts are available only after the provider response JSON was read; HTTP
rejections and body failures may have no usage. These diagnostics cannot recover
details discarded by an older deployed revision. No request retries are added.

Output validation failures additionally emit `validationReason` and, when
applicable, `validationPlatform`. These come only from locally created validation
errors and fixed enums, never exception messages or provider-supplied properties.
Reasons distinguish a missing platform, invalid post shape, missing Twitter text,
an overlong tweet, incomplete email, missing Instagram caption, insufficient
carousel slides, and malformed slide text. Diagnostics preserve HTTP status,
public response codes, and persisted generic errors. LinkedIn normalization is
described below.
The frontend maps generation errors to fixed user-facing copy, keeps the prompt,
and requires a manual retry; it never displays arbitrary provider error messages.

LinkedIn provider output now normalizes a nonblank string, a sole-field
`{ text: "..." }` object, or an array of these into the existing `string[]`
response/persistence contract. Existing string arrays retain their text and
order. Empty values, missing output, nontext entries, unrecognized fields and
ambiguous objects (such as `{ text, body }`) still fail validation. The prompt
explicitly requests an array of plain strings. Other platform rules, the token
cap, and the no-retry policy are unchanged; no text is invented or stringified.

The single authorized synthetic reproduction on 2026-10-28 identified
`INVALID_PLATFORM_POSTS` for LinkedIn after provider HTTP 200 and finish reason
`stop`. The rejected raw value was not retained, so its exact shape is unknown.
This normalization repairs known unambiguous text variants offline; it does not
claim to repair every possible malformed provider response or to prove the
historical value was one of those variants. Unsupported shapes retain safe
validation diagnostics. See [recommender authentication](recommender-auth.md)
for the separately confirmed cold-start deadline mismatch and release setting.

A subsequent authorized synthetic request on 2026-10-28 completed successfully
with Twitter, LinkedIn and a three-slide Instagram carousel. Authenticated
history returned identical saved content and grounding metadata (`v1.0`). The
public frontend displayed the record on desktop and a phone-sized viewport.
This is one successful verification, not a general output-quality guarantee.

The three failures observed on 2026-10-26 at 09:56–09:58 UTC on revision
`market-aura-api-00005-t44` requested Twitter, LinkedIn, and Instagram. Each
returned provider HTTP 200 with finish reason `stop`, parsed successfully, and
failed at `output_validation`. This establishes a provider-output contract
failure, not token truncation, a transport failure, or a job-completion write
failure. The exact field cannot be recovered: that revision did not log a
validation reason or retain rejected output. Do not infer a specific field from
token counts or replay a paid request automatically. Offline controller fixtures
now cover invalid LinkedIn shape, overlong tweets, and incomplete carousels for
the same three-platform selection. They reproduce candidate failure paths, not
the discarded production response. On a future authorized attempt, correlate the
safe reason/platform with the job ID before choosing a contract or prompt fix.

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
