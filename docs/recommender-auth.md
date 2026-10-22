# Private Cloud Run recommender calls

The Node API obtains a Google-signed service ID token from Cloud Run's fixed
metadata endpoint and sends `Authorization: Bearer <ID token>` to Python.
It never forwards an end-user JWT, Groq key, or downloaded service-account key.
No dependency installation is needed: Node's native fetch shares one deadline
across identity acquisition, inference, and JSON parsing. Tokens are fetched
afresh for each generation, are not logged or persisted, and are never sent
through redirects. There are no retries or anonymous fallback requests.

## Configuration

| Variable | Local development | Private Cloud Run |
| --- | --- | --- |
| `RECOMMENDER_URL` | `http://127.0.0.1:8001/recommend` | `https://<canonical-python-service>.run.app/recommend` |
| `RECOMMENDER_AUTH_MODE` | `none` (default for loopback) | `cloud-run` (default for remote URLs) |
| `RECOMMENDER_AUDIENCE` | Unset/empty | Canonical Python service origin, without `/recommend` or trailing slash; defaults to the request origin |
| `RECOMMENDER_HEALTH_URL` | Optional same-origin `/health` | Optional same-origin `/health`; defaults to that path on the configured service |
| `RECOMMENDER_TIMEOUT_MS` | Default 15000 | Integer 1–120000; allow for Python cold starts |

The MVP supports the canonical `run.app` service URL. Traffic-tag endpoints,
custom domains/audiences, and off-cloud service-account credentials are outside
this client's scope. Audience paths, HTTP remote endpoints, credentials in URLs,
different-origin audiences/health URLs, and remote unauthenticated mode fail
configuration validation. On Cloud Run (`K_SERVICE` is set), a missing remote
URL or local `none` mode fails startup rather than using a local default.
Do not copy the example's local `RECOMMENDER_AUTH_MODE=none` into Cloud Run.

Identity acquisition failure, expired/wrong-audience tokens, or denied access
never trigger an unauthenticated Python request. Generation retains the existing
ungrounded Groq fallback, with a safe reason in `generatedContent.grounding`.
HTTP 401/403, timeouts, and authentication failures are distinguishable without
exposing provider bodies or token values. Monitor these reasons after deployment;
an ungrounded generation is not evidence that the private integration works.

## Deployment prerequisites (not applied by this change)

1. Attach a dedicated service account to the Node Cloud Run service.
2. Keep the Python service authenticated and grant the Node service account
   `roles/run.invoker` on that Python service only. Python's application server
   does not implement IAM verification; the Cloud Run ingress enforces it.
3. Set the canonical URLs/audience above and choose ingress/network routing that
   allows the Node service to reach Python. IAM authentication alone does not
   configure internal-only networking.
4. Verify deployed access succeeds for Node's identity and is denied without a
   token or with the wrong identity/audience. This requires separate deployment
   authorization; offline tests cannot prove real IAM policy or routing.

Reference: [Google Cloud Run service-to-service authentication and metadata tokens](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).

## Offline tests

`node --test tests/recommenderClient.test.js tests/recommenderGeneration.test.js`
uses only synthetic tokens and mocked metadata, Python, Groq, and persistence.
It covers configuration, local compatibility, exact audience/header/payload,
authentication denials, token validation, shared timeouts, no retries/downgrades,
safe grounding fallback, and credential redaction. `npm test` additionally runs
the existing local Python integration; set `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` to use cached artifacts without model-hub requests.
