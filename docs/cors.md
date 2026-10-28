# CORS origin configuration

The API accepts browser requests with an `Origin` header only when that exact
origin is configured. The check runs before JSON parsing, authentication and route
handlers, so rejected requests cannot trigger account access, database writes or
provider calls. Rejections return HTTP 403 with `ORIGIN_NOT_ALLOWED` and no CORS
permission or credential headers.

## Configuration

Set `CORS_ALLOWED_ORIGINS` to a comma-separated list of canonical origins. Each
origin contains only scheme, hostname and optional non-default port. Do not include
a trailing slash, path, query, fragment, credentials, wildcard or the value `null`.
Use lowercase hostnames and omit default ports such as `:443` for HTTPS. Spaces
around comma-separated entries are trimmed and duplicate entries are removed.

Development example (also in `.env.example`):

```dotenv
NODE_ENV=development
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

When the variable is absent outside production, only those two Vite loopback
origins are allowed. An explicit list replaces the defaults. An explicitly empty
or invalid list fails startup.

Production must set `NODE_ENV=production` and a nonempty list of HTTPS origins.
There is no production fallback. For example, replace the placeholder below with
the actual frontend origin when a deployment is approved:

```dotenv
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

Every additional domain or Vercel preview origin must be listed separately.
Subdomains, different schemes and different ports do not match implicitly.
`FRONTEND_URL` does not populate this allowlist. Settings are read at startup;
restart the process after changing them. This change does not provision a domain,
edit the real `.env`, or deploy anything.

## Request behavior

- Allowed origins receive their exact `Access-Control-Allow-Origin` value and
  `Access-Control-Allow-Credentials: true`. The existing frontend's cookies and
  Authorization bearer headers remain supported; authentication is still required
  on protected routes. Login cookie attributes are unchanged.
- Preflight responses use HTTP 204, methods `GET, HEAD, POST, PUT, DELETE`, and
  request headers `Content-Type, Authorization`. Other methods or headers are not
  granted, and requested headers are never reflected automatically. Browser
  enforcement prevents a follow-up request when preflight requirements do not match.
- `Retry-After` is exposed to allowed browser origins for generation-limit errors.
- Requests without an `Origin` header, including health checks and server clients,
  continue through normal routing and authentication without CORS grant headers.
  A supplied empty or `null` origin is rejected.
- Responses include `Vary: Origin`, including denied and no-Origin responses, so
  caches can distinguish these variants.

CORS governs browser access. It does not authenticate clients or prevent a
non-browser client from omitting or forging its Origin header. Existing route
authentication and generation limits continue to apply.

## Regression tests

```bash
node --test tests/cors.test.js tests/corsConfig.test.js
npm test
```

Tests exercise the production Express application over loopback HTTP, including
preflight, rejected credentialed writes, login/logout contracts, exact origin
matching and configuration validation. Persistence, passwords and providers are
mocked; no database connection or paid API is used. The full backend suite also
runs the existing local Python recommender integration with Groq mocked.
