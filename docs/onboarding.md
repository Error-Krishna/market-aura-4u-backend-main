# Onboarding and safe user responses

`POST /api/v1/auth/onboarding` requires authentication. It accepts exactly the
six fields already sent by the frontend:

| Field | Accepted value |
| --- | --- |
| `companyName` | Nonblank string, at most 5000 UTF-16 code units before trimming |
| `industry` | Nonblank string, at most 5000 code units before trimming |
| `brandTone` | Nonblank string, at most 5000 code units before trimming |
| `uvp` | Nonblank string, at most 5000 code units before trimming |
| `targetAudience` | Nonblank string, at most 5000 code units before trimming |
| `platforms` | One or more unique values from `twitter`, `linkedin`, `instagram`, `facebook`, `email`, `blog` |

Missing, null, malformed, oversized or additional fields return HTTP 400 with
`INVALID_ONBOARDING_INPUT` before a database write. Client-supplied account IDs,
privileges, credits and nested profile overrides are not accepted. Onboarding
uses generation's existing brand-context validator to keep submitted context
aligned with generation requirements. Text is trimmed without mutating the request.

## Persistence and completion

The account ID comes from the authenticated database user. A single
`findByIdAndUpdate` with validators writes the validated fields and
`onboardingCompleted: true` together. It uses individual brand-field paths instead
of replacing the entire brand profile. Existing marketing goals, voice description,
credentials, billing fields and other settings are preserved.

Invalid resubmission leaves an existing completed profile unchanged. Schema
validation failures return 400, a deleted account returns 404, and database errors
return a generic 500 without claiming completion or returning/logging private
database messages. No user backfill or data migration is performed.

Malformed JSON receives a generic 400 with `INVALID_ONBOARDING_INPUT`; a body over
the existing 100 KiB JSON limit receives 413 with `ONBOARDING_PAYLOAD_TOO_LARGE`.
These errors do not log or echo the submitted brand context and cannot write a
profile. Login/signup parser-error behavior and attempt budgets remain intact.

## Allowlisted responses

Both onboarding updates and profile queries use a positive field projection and
explicit serializers. Serializers construct each nested object field by field;
they never return a Mongoose document or spread a subdocument. Passwords, social
access tokens, payment/subscription records, internal fields and future unknown
schema fields are excluded even if an adapter returns them despite the projection.

The onboarding response retains HTTP 200 and the `success`, `message`, `user`
envelope. `user` contains only:

- `id`, `name`, `email`, `onboardingCompleted`, `isPremium`;
- `credits` with `monthly` and `used`;
- `brandProfile` with `companyName`, `industry`, `uvp`, `targetAudience`,
  `marketingGoal`, `brandVoice` (`tone`, `description`), and `platforms`.

`GET /api/v1/auth/profile` retains the flat `success`, `data` response used by the
frontend: `id`, `name`, `email`, `isOnboarded`, `isUserPremium`, `joinedAt`, `credits`
(`total`, `used`, `remaining`), and flat brand fields. It now includes `uvp` and
`isPremium` so persisted context and the existing AuthProvider field are available.
The legacy `isUserPremium` dashboard calculation is preserved. These display
fields do not enable the excluded payment/subscription features.

Optional missing text is represented as an empty string; missing tone defaults to
`Professional`. Malformed nested objects and unsupported platform values are not
serialized. Missing/invalid credit numbers use the existing 100/0 defaults, and
displayed remaining credits are clamped to zero. This normalization affects only
responses; it does not write to the database.

## Regression tests

```bash
node --test tests/onboarding.test.js tests/userResponses.test.js tests/onboardingRoutes.test.js
npm test
```

Tests verify validation before writes, owner-scoped atomic updates, preservation
of existing fields and another account, safe nested output, parser failures,
database failures, and a complete HTTP onboarding-to-profile round trip. All
persistence is mocked, and provider calls are forbidden in these tests. The full
suite also runs the existing local Python recommender integration with Groq mocked.
