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

`request.user` is set on every request (`src/server/auth/plugin.ts`); the default policy
(`src/server/auth/access.ts`) already checks the level of every `/api` route (below). Your route
adds what only it knows, such as ownership:

```ts
app.get('/items', async (request) => listItemsFor(request.user!.id));  // GET: level read, by the policy

app.delete<{ Params: { id: string } }>('/items/:id', async (request, reply) => {  // DELETE: level write
  const item = await getItem(request.params.id);
  if (!item) return reply.code(404).send({ error: 'Not found' });
  if (item.createdBy !== request.user!.id && request.user!.level !== 'admin') {
    return reply.code(403).send({ error: 'You do not have permission to do this' });
  }
  await deleteItem(item.id);
  return reply.code(204).send();
});

app.get('/me', { config: { access: 'user' } }, ...);       // an exception, declared on its route
```

`requireRole(...)` still works for a stricter check on one route. Frontend: `GET /api/me` returns
the user, their roles and their highest level, to show the user menu and decide which buttons to
show. That is convenience only; the server checks every request.

## Python (FastAPI starter)

The default policy (`app/access.py`, on the whole app) checks the level of every `/api` route; a
route declares an exception with `@access(...)` under its decorator:

```python
from .access import access
from .auth import CurrentUser

@app.get("/api/items")                     # GET: level read, by the policy
def list_items(user: CurrentUser): ...

@app.delete("/api/items/{item_id}")        # DELETE: level write; ownership in the handler
def delete_item(item_id: int, user: CurrentUser): ...

@app.get("/api/me")
@access("user")                            # any signed-in user, also without a role
def me(user: CurrentUser): ...
```

## .NET (ASP.NET Core starter)

`EasyAuthHandler` turns the header into a normal `ClaimsPrincipal` (`ClaimTypes.NameIdentifier`
= object id, `ClaimTypes.Role` = roles), so the standard tools work:

The default policy (`Auth/AccessPolicy.cs`, `app.UseAccessPolicy()`) checks the level of every
`/api` route; a route declares an exception with `.WithAccess(...)` or `[Access(...)]`:

```csharp
var api = app.MapGroup("/api");
api.MapGet("/items", List);                         // GET: level read, by the policy
api.MapDelete("/items/{id}", Delete);               // DELETE: level write; ownership in Delete
api.MapGet("/me", Me).WithAccess(Access.User);      // any signed-in user, also without a role
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

- Sign-out: `/.auth/logout?post_logout_redirect_uri=/`; sign in as another user:
  `/.auth/login/aad?prompt=select_account&post_login_redirect_uri=/` (both served by the platform,
  not available locally). They belong in the user menu every app with sign-in has (skill
  ui-and-brand).
- Use relative links. Don't link to `/.auth/login/aad` anywhere else; unauthenticated users are
  redirected automatically.
- Calls from the browser to the app's API are same-origin: the sign-in cookie goes along, no
  tokens in JavaScript. Use `fetch('/api/…')`, never store tokens in `localStorage`.

## What each role may do

Every role has a **level** and a sentence. AGENTS.md's This app table has a **Roles** row with
both, as the owner set them in the portal; `.platform/roles.json` holds them for the code, and
`platform app roles` prints the current ones (it signs in to the portal by itself; `--json` for a
script):

```
Reader     read     Can see the app and its data, but can't change anything.
Editor     write    Can do what a Reader can, and add and change the app's everyday data.
Admin      admin    Can do everything in the app, including its settings and other users' data.
```

The levels nest: `admin` includes `write`, `write` includes `read`. A role without a level has no
access. Build every role exactly as its level and sentence say: what it may see, what it may
change. If a sentence leaves something open (may an Editor delete?), ask the user instead of
guessing, and suggest that the owner sharpens it in the portal. Never give a role more.

## The default access policy (never weaken it)

The starter installs one policy on every `/api` route (the file marked `saf:access-policy`), deny
by default:

| Request | Needs the level |
|---|---|
| `GET`, `HEAD` | `read` |
| `POST`, `PUT`, `PATCH`, `DELETE` | `write` |
| `/api/admin/**`, `/api/settings/**` (any method) | `admin` |
| a user without any role | refused (403) |

- So put the app's settings under `/api/settings/` and admin tools under `/api/admin/`, and never
  change data in a `GET`.
- A route that needs something else says so in its own declaration: `access: 'read' | 'write' |
  'admin' | 'user' | 'public'` (`user`: any signed-in user, like `/api/me`; `public`: no sign-in).
  Stricter is always fine. Looser (a Reader may `POST` a search: `access: 'read'`) only with the
  user's OK, and record it in `docs/architecture.md`.
- Per-record rules (only the author edits their entry) come on top, in the route: the policy
  checks the level, your code checks ownership.
- The contract test (marked `saf:access-contract-test`) walks every route and checks the policy.
  Never skip, weaken or delete it; when it fails, fix the route. `platform check` reports a missing
  policy or test as PC066.
- `.platform/roles.json` is the platform's (updated by `platform agent-files update`): never edit
  it by hand. A role the token carries but the file doesn't name has no access, so after the owner
  adds a role in the portal, update the agent files first.
- An app from an older starter: if `platform check` reports PC066, add the policy and the test as
  above, in the app's stack (the starter of a new app shows how).

## Adding or changing roles

1. The owner adds the role in the portal (value, display name, level and what it may do) and gives
   it a group. This is a request that may need approval.
2. Then run `platform agent-files update` (it writes `.platform/roles.json` and the Roles row) and
   `platform app roles` to see it. Only then use the new role value in code. Until then, nobody has
   it (requests get 403).
3. Document roles in `docs/architecture.md` (table: role → what it allows), from their descriptions.
4. Removing a role: remove its use from code first, release, then remove it in the portal.

## Public (anonymous) apps or pages

An app without sign-in (`.platform/roles.json` says `"signIn": false`) has no roles: its routes
declare `public` (the policy refuses everything else), `/api/me` answers 401 and the user menu
goes away.


Only if the instance allows it and the owner requested it in the portal (it needs approval). Then
some requests arrive without the header: `request.user` is `null`. Keep guards on everything that
is not explicitly public, and never expose other users' data on public routes.

## Calling other APIs on behalf of the user

Not available by default (no access tokens are passed to the app). Calls between apps and to
Microsoft Graph need the platform team. Ask; don't add MSAL or client secrets.

## Checklist

- [ ] The default access policy and its contract test are in place and run (`saf:access-policy`,
      `saf:access-contract-test`); every exception is declared on its route, agreed and documented.
- [ ] Reading is a `GET`, changing data is not; settings under `/api/settings/`, admin tools under
      `/api/admin/`.
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
