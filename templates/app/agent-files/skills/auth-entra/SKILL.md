---
name: auth-entra
description: Use when code needs the signed-in user, their name, email or id, app roles (Reader, Editor, Admin …), permission checks, per-user data ownership, a sign-out link, public (anonymous) pages, or a local fake user for development. Also use when the user asks for "login", "authentication", "users", "permissions", "admin only", or when requests fail with 401 or 403.
---

# Sign-in (Microsoft Entra ID) and app roles

The platform signs users in **before** a request reaches the app (Azure Container Apps built-in
authentication, "Easy Auth", with Microsoft Entra ID). The app never implements login, OAuth,
OIDC, JWT validation, password storage or session cookies.

## How it works

1. A user opens the app. If not signed in, the platform redirects to the company Microsoft sign-in.
2. Entra checks that the user (via an Entra group) has one of the app's roles. Roles are defined
   by the owner in the portal, each with a sentence saying what it may do, and given to a group:
   usually the role's app group, whose members the owner manages in the portal. Users without a role can't
   sign in to the app at all.
3. Each request reaches the app with **`X-MS-CLIENT-PRINCIPAL`**: base64-encoded JSON
   `{ auth_typ, name_typ, role_typ, claims: [{ typ, val }] }`. In Azure the platform's sign-in
   sets it; locally anyone can send it, so local behaviour is not a security test.
4. Health endpoints are called by the platform directly, without the header.

## The user object (all starters)

| Field | Claim | Use |
|---|---|---|
| `id` | `http://schemas.microsoft.com/identity/claims/objectidentifier` | **Key for user data** (stable). |
| `name` | `name` | Display only. |
| `email` | `preferred_username` (usually the email/UPN) | Display, notifications. Can change: never a key. |
| `roles` | `roles` | App role **values** as defined in the portal, case-sensitive. |

Parsers (framework-free, copy into any app): [helpers/principal.ts](helpers/principal.ts),
[helpers/principal.py](helpers/principal.py), [helpers/ClientPrincipal.cs](helpers/ClientPrincipal.cs).

## Node/TS (Fastify starter)

`request.user` is set on every request (`src/server/auth/plugin.ts`). Guard routes:

```ts
import { requireRole, requireUser } from '../auth/plugin.js';

app.get('/items', { preHandler: requireUser }, async (request) => {
  return listItemsFor(request.user!.id);           // ownership: only the user's items
});

app.delete<{ Params: { id: string } }>(
  '/items/:id',
  { preHandler: requireRole('Editor', 'Admin') },  // any of these roles
  async (request, reply) => {
    const item = await getItem(request.params.id);
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.createdBy !== request.user!.id && !request.user!.roles.includes('Admin')) {
      return reply.code(403).send({ error: 'You do not have permission to do this' });
    }
    await deleteItem(item.id);
    return reply.code(204).send();
  },
);
```

Frontend: call `GET /api/me` to show the name and decide which buttons to show. That is
convenience only; the server checks every request.

## Python (FastAPI starter)

```python
from fastapi import Depends
from .auth import CurrentUser, require_role

@app.get("/api/items")
def list_items(user: CurrentUser): ...

@app.delete("/api/items/{item_id}", dependencies=[Depends(require_role("Editor", "Admin"))])
def delete_item(item_id: int, user: CurrentUser): ...
```

## .NET (ASP.NET Core starter)

`EasyAuthHandler` turns the header into a normal `ClaimsPrincipal` (`ClaimTypes.NameIdentifier`
= object id, `ClaimTypes.Role` = roles), so the standard tools work:

```csharp
var api = app.MapGroup("/api").RequireAuthorization();
api.MapDelete("/items/{id}", Delete).RequireAuthorization(p => p.RequireRole("Editor", "Admin"));
var userId = user.FindFirstValue(ClaimTypes.NameIdentifier);
```

## Local development

No platform sign-in on a laptop. Simulate a user:

```bash
DEV_FAKE_USER=dev@contoso.com
DEV_FAKE_ROLES=Admin,Editor      # comma-separated role values
```

Node: in `.env`; Python: in `.env`; .NET: `src/App/Properties/launchSettings.json`. Test other
roles by changing `DEV_FAKE_ROLES`, and test "no role" with an empty value. The apps refuse to
start when these are set on Azure (`CONTAINER_APP_NAME` present). In tests, send a real-looking
`X-MS-CLIENT-PRINCIPAL` header (see the starters' tests).

## Sign-out and links

- Sign-out: link to `/.auth/logout` (served by the platform, not available locally).
- Use relative links. Don't link to `/.auth/login/aad` yourself; unauthenticated users are
  redirected automatically.
- Calls from the browser to the app's API are same-origin: the sign-in cookie goes along, no
  tokens in JavaScript. Use `fetch('/api/…')`, never store tokens in `localStorage`.

## What each role may do

AGENTS.md's This app table has a **Roles** row: each role value and what it may do, as the owner
described it in the portal. `platform app roles` prints the current ones (it signs in to the portal
by itself; `--json` for a script):

```
Reader     Can see the app and its data, but can't change anything.
Editor     Can do what a Reader can, and add and change the app's everyday data.
Admin      Can do everything in the app, including its settings and other users' data.
```

Build every role exactly as its description says: what it may see, what it may change. If a
description leaves something open (may an Editor delete?), ask the user instead of guessing, and
suggest that the owner sharpens the description in the portal. Never give a role more than its
description says.

## Adding or changing roles

1. The owner adds the role in the portal (value, display name and what it may do) and gives it a
   group. This is a request that may need approval.
2. Only then use the new role value in code. Until then, nobody has it (requests get 403). Run
   `platform app roles` to see that it is there and what it may do.
3. Document roles in `docs/architecture.md` (table: role → what it allows), from their descriptions.
4. Removing a role: remove its use from code first, release, then remove it in the portal.

## Public (anonymous) apps or pages

Only if the instance allows it and the owner requested it in the portal (it needs approval). Then
some requests arrive without the header: `request.user` is `null`. Keep guards on everything that
is not explicitly public, and never expose other users' data on public routes.

## Calling other APIs on behalf of the user

Not available by default (no access tokens are passed to the app). Calls between apps and to
Microsoft Graph need the platform team. Ask; don't add MSAL or client secrets.

## Checklist

- [ ] Every `/api` route has `requireUser` or `requireRole` (or is deliberately public and documented).
- [ ] Data queries filter by ownership where needed (`created_by = user.id`).
- [ ] Users are stored by `id` (object id), not email.
- [ ] Role values match the portal exactly (case-sensitive) and are documented.
- [ ] Tests cover 401 (no user), 403 (wrong role) and 200 (right role).

## Common mistakes

- Building a login page, adding `passport`, MSAL, NextAuth or JWT validation → remove it; the
  platform already signed the user in.
- Hiding admin buttons in React but not guarding the API route.
- Using `email` as a primary key → breaks when a user's UPN changes.
- Reading `X-MS-CLIENT-PRINCIPAL-NAME` and trusting it for authorisation → use the parsed roles.
- Expecting role changes to apply instantly: roles are in the sign-in token; users get new roles
  after signing out and in again.
- Making `/healthz` require sign-in → probes fail.
