---
name: database-postgres
description: Use when the app stores or reads data in PostgreSQL - connecting, writing queries, designing tables, adding or changing columns, writing migrations, choosing an ORM, seeding test data, running a local database, or fixing database sign-in, permission, SSL or connection errors. Also use before any change that could delete or rename data.
---

# PostgreSQL (Azure Database for PostgreSQL Flexible Server)

One server and database per app and environment, requested in the portal. **Passwordless only:**
the server accepts Microsoft Entra tokens, no passwords. The app signs in as its managed identity.

## What the platform provides

| Env var | Meaning |
|---|---|
| `DATABASE_HOST` | server host name (`<server>.postgres.database.azure.com`) |
| `DATABASE_NAME` | database name |
| `DATABASE_USER` | database role of the app's managed identity |
| `AZURE_CLIENT_ID` | client id of the managed identity (used to get the token) |

The app's identity can create and change tables in its database. TLS is required. Size S/M servers
are "Burstable": fine for normal business load; heavy batch jobs can exhaust CPU credits (the owner
gets an alert and can request a larger size).

## Connecting (Node/TS starter)

Already implemented, active when `DATABASE_HOST` is set: `src/server/db/database.ts`.
Essentials, for reference:

```ts
import { ManagedIdentityCredential, DefaultAzureCredential } from '@azure/identity';
import pg from 'pg';

const credential = process.env.AZURE_CLIENT_ID
  ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
  : new DefaultAzureCredential();                       // your `az login` locally
const pool = new pg.Pool({
  host: process.env.DATABASE_HOST, database: process.env.DATABASE_NAME, user: process.env.DATABASE_USER,
  // called for every new connection → fresh token (cache it; refresh 5 min before expiry)
  password: async () => (await credential.getToken('https://ossrdbms-aad.database.windows.net/.default'))!.token,
  ssl: { rejectUnauthorized: true },
});
```

Use the pool from route handlers: `const { rows } = await db.pool.query('SELECT … WHERE id = $1', [id])`.
Pass `db` into `buildApp` (or a plugin) instead of importing a global.

**ORMs:** plain `pg` with SQL is the default. Drizzle or Kysely also work with the same pool.
Prisma needs a connection URL with a password and doesn't refresh tokens: avoid it.

## Python

```python
import psycopg
from psycopg_pool import ConnectionPool
from azure.identity import ManagedIdentityCredential, DefaultAzureCredential

SCOPE = "https://ossrdbms-aad.database.windows.net/.default"
credential = ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"]) if os.environ.get("AZURE_CLIENT_ID") else DefaultAzureCredential()

class EntraConnection(psycopg.Connection):
    @classmethod
    def connect(cls, conninfo="", **kwargs):
        kwargs["password"] = credential.get_token(SCOPE).token   # fresh token per connection
        return super().connect(conninfo, **kwargs)

pool = ConnectionPool(
    f"host={os.environ['DATABASE_HOST']} dbname={os.environ['DATABASE_NAME']} user={os.environ['DATABASE_USER']} sslmode=require",
    connection_class=EntraConnection, min_size=1, max_size=10, open=False)
# open in the FastAPI lifespan: pool.open(); close on shutdown: pool.close()
```

Packages: `psycopg[binary]`, `psycopg-pool`, `azure-identity` (pin exact versions). SQLAlchemy:
use `create_engine("postgresql+psycopg://", creator=…)` or a `do_connect` event that sets the token.
Migrations: Alembic.

## .NET

```csharp
// Npgsql + Azure.Identity
var credential = new ManagedIdentityCredential(ManagedIdentityId.FromUserAssignedClientId(config["AZURE_CLIENT_ID"]));
var dataSourceBuilder = new NpgsqlDataSourceBuilder(
    $"Host={config["DATABASE_HOST"]};Database={config["DATABASE_NAME"]};Username={config["DATABASE_USER"]};SSL Mode=Require");
dataSourceBuilder.UsePeriodicPasswordProvider(async (_, ct) =>
    (await credential.GetTokenAsync(new(["https://ossrdbms-aad.database.windows.net/.default"]), ct)).Token,
    TimeSpan.FromMinutes(30), TimeSpan.FromSeconds(10));
builder.Services.AddSingleton(dataSourceBuilder.Build());   // EF Core: options.UseNpgsql(dataSource)
```

Locally use `DefaultAzureCredential` instead of `ManagedIdentityCredential`. Migrations: EF Core
migrations applied at startup with `context.Database.MigrateAsync()` (one replica at a time is
fine for small apps; keep them backward compatible).

## Migrations (Node starter)

At startup (after the server listens; `/readyz` stays 503 until done) the app applies
`migrations/NNNN_description.sql` files in order, each in a transaction, recorded in
`schema_migrations`, under an advisory lock so replicas don't collide.

```sql
-- migrations/0002_add_item_status.sql
ALTER TABLE items ADD COLUMN status text NOT NULL DEFAULT 'open';
CREATE INDEX IF NOT EXISTS items_status_idx ON items (status);
```

- Never edit, rename or delete a pushed migration. Fix mistakes with a new one.
- `CREATE INDEX CONCURRENTLY` can't run inside a transaction: on small tables use a plain
  `CREATE INDEX`; on large tables ask before doing it.

## Backward-compatible changes (expand/contract) — mandatory

Rollback runs the **previous** image against the **current** schema, and during a deploy old and
new replicas run at the same time. So each release must work with the schema before and after it.

| Goal | Release 1 (expand) | Release 2 (migrate) | Release 3 (contract) |
|---|---|---|---|
| Add a required column | add column nullable or with default; code writes it | backfill; add `NOT NULL` if needed | — |
| Rename a column | add new column; write both, read new with fallback | backfill old → new | stop writing old; drop old column (ask the user first) |
| Remove a column | stop reading and writing it in code | — | drop the column (ask first) |
| Change a type | add new column with the new type, write both | backfill | switch reads, then drop old later |

Never in one release: drop/rename a column or table that the previous release uses, add `NOT NULL`
without a default to a populated table, or change the meaning of existing values.

## Data rules

- Store user references as the Entra object id (`text`), not email.
- Always parameterised queries (`$1`), never string concatenation.
- Use `timestamptz` and UTC. Use `numeric` for money, never floating point.
- Paginate list endpoints (`LIMIT`/`OFFSET` or keyset), cap page size.
- Prod data never goes to nonprod or a laptop. Seed nonprod with a script or a migration that only
  inserts obviously fake data (and is safe to run in prod, or is guarded by an env var).

## Local development

```bash
docker run --rm -e POSTGRES_PASSWORD=localdev -p 5432:5432 postgres:17.6
# .env
DATABASE_HOST=localhost
DATABASE_NAME=postgres
DATABASE_USER=postgres
DATABASE_PASSWORD=localdev   # local only; the app refuses it on Azure
```

Without Docker: keep the queries in one server-side module and test the routes with an in-memory
stand-in of it. The data still goes through the app's API to the database in nonprod; never keep
it in the browser (`localStorage`, IndexedDB) to make the local preview work.

## Common mistakes

- Using a password or a connection string from a guide → the server rejects passwords; use tokens.
- Fetching one token at startup and reusing it → it expires after about an hour; get one per new
  connection (the provider above does it).
- `ssl: false` against Azure → connection refused.
- Checking the database in `/healthz` → restart loops; put it in `/readyz`.
- Dropping a column in the same release that stops using it → rollback breaks.
- `password authentication failed for user …` → wrong `DATABASE_USER` or token for another identity;
  see `troubleshooting`.
