---
name: secrets-and-config
description: Use when adding or changing a setting, environment variable, feature flag, API key, password, token or any other secret, when editing platform.yaml (port, size, scaling, health paths, env vars, secrets, deploy branches, per-environment overrides), or when the app fails at startup with a missing or invalid configuration value.
---

# Configuration and secrets

All configuration reaches the app as **environment variables**. Values that differ per
environment or are secret never live in code or config files.

## Where each kind of value comes from

| Kind | Example | Where it is defined |
|---|---|---|
| Platform-injected | `PORT`, `AZURE_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `CONTAINER_APP_NAME`, `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `STORAGE_BLOB_ENDPOINT`, `FRONT_DOOR_ID` | Set automatically. Never put them in `platform.yaml` (the schema rejects them). Data and Front Door values exist only when the portal request was approved. |
| Plain setting | `LOG_LEVEL=info`, `FEATURE_EXPORT=true`, `SUPPORT_EMAIL=…` | `platform.yaml` → `runtime.env` (`name`, `value`) |
| Per-environment setting | different `LOG_LEVEL` in nonprod | `platform.yaml` → `environments.<name>.env` |
| Secret | external API key, SMTP password, webhook signing key | name in `platform.yaml` → `secrets`, mapped in `runtime.env` (`name`, `secret`); value set by the owner in the portal per environment |
| Local only | `DEV_FAKE_USER`, `DATABASE_PASSWORD` for a local DB | `.env` (git-ignored) or `launchSettings.json` (.NET, no secrets) |

Azure services (database, storage) need **no secret**: the app uses its managed identity
(`AZURE_CLIENT_ID`). If a guide tells you to put a connection string with a password or an account
key into a secret, don't: use the `database-*` or `blob-storage` skill.

## platform.yaml

```yaml
schemaVersion: "1.0-draft"
app: my-app                     # must match the portal registration; never change
runtime:
  port: 8080                    # must match the port the app listens on (EXPOSE)
  size: s                       # xs | s | m | l (CPU/memory; larger sizes may need approval)
  scale:
    minReplicas: 0              # 0 = scales to zero when idle (first request is slower)
    maxReplicas: 3
  health:
    liveness: /healthz
    readiness: /readyz
  env:
    - name: LOG_LEVEL
      value: info
    - name: SMTP_PASSWORD       # env var name the code reads
      secret: smtp-password     # secret name (must be listed under `secrets`)
secrets:
  - smtp-password
environments:
  nonprod:
    env:
      - name: LOG_LEVEL
        value: debug
    scale:
      minReplicas: 0
  prod:
    scale:
      minReplicas: 1            # always one warm replica in prod
deploy:
  branches: ["*"]               # branches that deploy to nonprod on push
```

Rules (checked by `platform check`): env var names `UPPER_SNAKE_CASE`; secret names lowercase
letters, digits and `-` (max 127); every `secret:` reference listed under `secrets`; no reserved
names (`PORT`, `AZURE_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`). What the app is
*allowed* to have (databases, URL, roles, network, budget) is not in this file: that is a portal
request.

## Adding a secret: step by step

1. Pick names: secret `payment-api-key`, env var `PAYMENT_API_KEY`.
2. Add both to `platform.yaml` (as above).
3. Read it in code through the config module (below) and fail clearly when it is missing.
4. Tell the user: "Before you push, open the app in the portal and set the secret
   `payment-api-key` for **every** environment (nonprod and prod). The deploy fails if a
   referenced secret has no value." Never ask them to paste the value to you.
5. Locally: the user puts `PAYMENT_API_KEY=…` into `.env`. Don't open or print `.env`.
6. Document it in `docs/architecture.md` (Configuration table: name, purpose, secret yes/no).
7. Changed values reach running apps automatically, which can take up to about 30 minutes; the
   next deploy picks them up immediately.

Rotating or removing: the owner changes the value in the portal; to remove, delete the code usage
first, release, then remove the name from `platform.yaml`.

## Reading configuration

Read all variables once at startup, validate, and stop with a clear message naming the variable
(never its value).

Node/TS (`src/server/config.ts`, zod):

```ts
const EnvSchema = z.object({
  // …existing fields
  PAYMENT_API_KEY: optionalString,                       // optional feature
  SUPPORT_EMAIL: z.email().default('it@contoso.com'),
  FEATURE_EXPORT: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
```

Then add the value to the `Config` interface and return object; pass `config` to code that needs
it instead of reading `process.env` all over the code.

Python (`app/config.py`): add a field to `Config` and read it with `_get(env, "NAME")` in
`load_config`. .NET: `builder.Configuration["NAME"]`, or bind an options class with
`builder.Services.AddOptions<PaymentOptions>().BindConfiguration("").ValidateDataAnnotations().ValidateOnStart()`.

## Checklist

- [ ] No value that differs per environment is hardcoded.
- [ ] No secret value in code, `platform.yaml`, tests, fixtures, docs, logs, error messages, URLs, commits.
- [ ] Every new variable is validated at startup and documented in `docs/architecture.md`.
- [ ] Every `secret:` is listed in `secrets`, and the user knows to set it in the portal before pushing.
- [ ] `platform check` passes (schema + secret scan).

## Common mistakes

- Committing `.env` or `appsettings.Development.json` with real keys → if it happened, tell the
  user the secret must be rotated (git history keeps it), then remove the file.
- Putting the secret value in `platform.yaml` `value:` → it is not secret there; use `secret:`.
- Adding a Key Vault URL or SDK call to fetch secrets → not needed, the platform injects them.
- Reading `process.env.X` deep in the code with a silent fallback → typos go unnoticed.
- Logging the whole config object at startup.
- Using a different secret name in `secrets` and `secret:` (check fails).
