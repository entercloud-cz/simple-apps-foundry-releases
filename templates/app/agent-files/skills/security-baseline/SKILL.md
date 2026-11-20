---
name: security-baseline
description: Use when handling user input, forms, file uploads, HTML rendering, SQL or shell commands, redirects, external API calls, HTTP security headers, CSP, CORS, cookies, rate limiting, dependency updates or vulnerability scan findings, or when reviewing a change for security (OWASP Top 10). Also use when the app is served through Azure Front Door (X-Azure-FDID check).
---

# Security baseline

The platform handles sign-in, TLS, secrets storage, network and image scanning. The app must still
get these right. Treat every request as hostile until validated and authorised.

## OWASP Top 10, applied

| Risk | Do this |
|---|---|
| Broken access control | Guard every route on the server (`requireUser`/`requireRole`), check ownership of every record, deny by default, return 404 for records the user may not see. Tests for 401/403. |
| Cryptographic failures | No own crypto, no secrets in code; TLS is done by the platform. Never disable certificate verification (`rejectUnauthorized: false`, `verify=False`, `TrustServerCertificate=true`). |
| Injection | Parameterised queries/ORM only. Never pass user input to a shell (`exec`, `subprocess(shell=True)`), `eval`, template strings for SQL, or file paths. |
| Insecure design | Limits on everything: page sizes, upload sizes, request rates for expensive endpoints, number of items per action. |
| Security misconfiguration | Keep the starter's security headers and error handler. No debug endpoints, no API docs UI in prod, no directory listings. |
| Vulnerable components | Pinned versions, committed lockfile, well-known maintained packages only. Fix critical/high scan findings by updating to the fixed version. |
| Identification & authentication | The platform signs users in. Never add own login, password storage or tokens in `localStorage`. |
| Software & data integrity | No `curl … | sh` in the Dockerfile; no scripts or styles from third-party CDNs at runtime; verify webhook signatures. |
| Logging & monitoring failures | Log security-relevant events (permission denied, validation failures in bulk, admin actions) without personal data. See `observability`. |
| SSRF | Don't fetch URLs supplied by users. If you must, allow-list hosts and schemes (`https` only) and block internal addresses. |

## Input validation

Validate shape, type, length and allowed values on the server for **every** body, query and path
parameter. Reject unknown fields. Return 400 with a helpful message.

```ts
// Fastify: JSON schema per route (validated before the handler runs)
app.post<{ Body: { title: string; dueDate?: string } }>('/items', {
  preHandler: requireRole('Editor'),
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        dueDate: { type: 'string', format: 'date' },
      },
    },
  },
}, handler);
```

Python: Pydantic models with `Field(min_length=…, max_length=…)`. .NET: records with
`[Required]`, `[StringLength]`, `[Range]` and `builder.Services.AddValidation()`.

## Output and the browser

- React escapes text. Never `dangerouslySetInnerHTML` with user content; if rich text is required,
  sanitise with a maintained library (e.g. DOMPurify) and record the decision.
- Content Security Policy from the starters: `default-src 'self'`, no inline scripts, no `eval`.
  Bundle all JS/CSS with Vite; don't load scripts or fonts from CDNs. If a feature needs another
  origin (e.g. an image host), add exactly that origin to the one directive that needs it.
- Other headers kept by the starters: `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`
  (no embedding in iframes), `Referrer-Policy`, HSTS.
- Redirects: only to relative paths you control; never to a URL from a query parameter.
- Downloads of user content: `Content-Disposition: attachment`, correct `Content-Type`.

## CORS

UI and API share one origin, so **no CORS** is needed. Never register CORS with `*` or reflect the
`Origin` header. If another known app must call this API, it needs a platform decision first.

## Front Door (`X-Azure-FDID`)

When the app is served through Azure Front Door, the platform sets `FRONT_DOOR_ID`. The starters
then reject requests whose `X-Azure-FDID` header doesn't contain that id (403), except `/healthz`
and `/readyz`, which the platform calls directly. Keep this check. Node:
`src/server/frontDoor.ts`; Python: middleware in `app/main.py`; .NET: middleware in `Program.cs`.
For other stacks:

```text
if FRONT_DOOR_ID is set and path not in (/healthz, /readyz):
    ids = split(header "X-Azure-FDID", ",") trimmed, lowercased
    if lower(FRONT_DOOR_ID) not in ids: respond 403
```

It doesn't cover the platform's sign-in pages (`/.auth/*`), which run before the app. Don't build
absolute URLs from `Host` or `X-Forwarded-Host`; use relative URLs.

## Rate limiting and abuse

Add `@fastify/rate-limit` (or the stack's equivalent) to endpoints that are expensive (exports,
searches, emails) or public. Key by user id, not IP, for signed-in users.

## Cookies and state

The platform's sign-in manages its own cookie. If the app needs its own cookie (rare), make it
`HttpOnly; Secure; SameSite=Lax`, store no secrets or personal data in it, and add CSRF protection
for state-changing form posts. JSON APIs called with `fetch` from the same origin plus
`SameSite=Lax` cookies are not exposed to classic CSRF; still use POST/PUT/DELETE for changes,
never GET.

## Dependencies

- Add a package only if it saves real work, is widely used and maintained. Pin the exact version.
- After adding or updating: commit the lockfile, run tests and `platform check`.
- Scan findings: update to the fixed version (patch/minor first). If no fix exists, tell the user
  and record it in `docs/decisions/`; never hide findings.
- Keep the base image patch version current; the scan flags outdated OS packages.

## Review checklist (before every commit with new endpoints or input)

- [ ] Every new route: guard + ownership + validated input + tests for 400/401/403.
- [ ] No string-built SQL, shell or paths; no `eval`.
- [ ] No secrets, tokens or personal data in code, logs or errors.
- [ ] No new CORS, CSP relaxation or inline scripts; if unavoidable, a decision record.
- [ ] New dependencies pinned and justified.

## Common mistakes

- Validating only in the React form → the API is callable directly.
- `SELECT * FROM items WHERE id = ${id}` → SQL injection. Use `$1` parameters.
- Returning `err.message` or stack traces from 500 errors → information leak.
- Adding `'unsafe-inline'` to the CSP to make a snippet work → move the code into the bundle.
- Registering `@fastify/cors` with `origin: true` "to fix an error" → the real issue is usually a
  wrong URL (absolute host instead of relative path).
