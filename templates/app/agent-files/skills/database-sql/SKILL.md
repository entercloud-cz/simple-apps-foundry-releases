---
name: database-sql
description: Use when the app stores or reads data in Azure SQL Database (SQL Server) - connecting with Microsoft.Data.SqlClient, Entity Framework Core, mssql/tedious (Node) or pyodbc (Python), designing tables, writing EF Core or SQL migrations, seeding test data, or fixing SQL login, firewall, timeout or permission errors.
---

# Azure SQL Database

One logical server and database per app and environment, requested in the portal (typical for
.NET teams). **Entra-only authentication**: there are no SQL logins or passwords. The app signs
in as its managed identity.

## What the platform provides

| Env var | Meaning |
|---|---|
| `DATABASE_HOST` | `<server>.database.windows.net` (always this name, never a `privatelink` name) |
| `DATABASE_NAME` | database name |
| `AZURE_CLIENT_ID` | client id of the app's managed identity |

The identity is a contained database user with rights to create and change tables. Tier is
provisioned Standard (no auto-pause, so no cold-start delay). TLS is always on.

## .NET (Microsoft.Data.SqlClient / EF Core)

```csharp
var cs = new SqlConnectionStringBuilder
{
    DataSource = config["DATABASE_HOST"],
    InitialCatalog = config["DATABASE_NAME"],
    Encrypt = SqlConnectionEncryptOption.Mandatory,
    // On Azure: the user-assigned managed identity. Locally: your Visual Studio / az login.
    Authentication = string.IsNullOrEmpty(config["AZURE_CLIENT_ID"])
        ? SqlAuthenticationMethod.ActiveDirectoryDefault
        : SqlAuthenticationMethod.ActiveDirectoryManagedIdentity,
    UserID = config["AZURE_CLIENT_ID"] ?? "",   // client id selects the identity; empty locally
    ConnectTimeout = 30,
}.ConnectionString;

builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlServer(cs, sql => sql.EnableRetryOnFailure()));
```

Packages (pin exact versions): `Microsoft.Data.SqlClient`, `Microsoft.EntityFrameworkCore.SqlServer`,
`AspNetCore.HealthChecks.SqlServer` (or a custom readiness check that runs `SELECT 1`).

Migrations: EF Core migrations (`dotnet ef migrations add AddItemStatus`), committed. Apply at
startup with `await db.Database.MigrateAsync()` before marking the app ready, or ask the platform
team about a migration job for large changes. Never `EnsureCreated()` in a migrated database.

## Node/TS (mssql)

```ts
import sql from 'mssql';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const credential = process.env.AZURE_CLIENT_ID
  ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
  : new DefaultAzureCredential();
const pool = await new sql.ConnectionPool({
  server: process.env.DATABASE_HOST!,
  database: process.env.DATABASE_NAME!,
  options: { encrypt: true },
  authentication: { type: 'token-credential', options: { credential } },
}).connect();
const { recordset } = await pool.request().input('id', sql.Int, id).query('SELECT * FROM items WHERE id = @id');
```

Pin `mssql` (it brings `tedious`). The node-ts starter already has this: `src/server/db/azureSql.ts`
(the pool, opened at startup) and `src/server/db/migrateAzureSql.ts`, which applies the T-SQL files
in `migrations/` at startup, all pending ones in one transaction under an application lock (one
replica at a time); a line with only `GO` splits a file into batches. Use `db.pool` for queries.

## Python (pyodbc)

```python
import struct, pyodbc
from azure.identity import ManagedIdentityCredential, DefaultAzureCredential

SQL_COPT_SS_ACCESS_TOKEN = 1256
credential = ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"]) if os.environ.get("AZURE_CLIENT_ID") else DefaultAzureCredential()

def connect() -> pyodbc.Connection:
    token = credential.get_token("https://database.windows.net/.default").token.encode("utf-16-le")
    attrs = {SQL_COPT_SS_ACCESS_TOKEN: struct.pack(f"<I{len(token)}s", len(token), token)}
    return pyodbc.connect(
        f"Driver={{ODBC Driver 18 for SQL Server}};Server=tcp:{os.environ['DATABASE_HOST']},1433;"
        f"Database={os.environ['DATABASE_NAME']};Encrypt=yes;TrustServerCertificate=no",
        attrs_before=attrs)
```

The image needs the Microsoft ODBC Driver 18 (install from Microsoft's package repository in the
Dockerfile, pinned). SQLAlchemy: `mssql+pyodbc` with a `do_connect` event that sets the token.

## Backward-compatible changes (expand/contract) — mandatory

Rollback runs the previous image against the current schema. Same rules as PostgreSQL:

1. **Expand**: add nullable columns or columns with defaults, new tables, new indexes.
2. **Migrate**: backfill data, switch the code to the new structure.
3. **Contract** (a later release, after asking the user): drop old columns/tables.

Never drop or rename a column/table that the previous release still uses. EF Core generates
`DropColumn`/`RenameColumn` happily: review every generated migration before committing.

## Data rules

- Store users by Entra object id (`nvarchar(36)`), not email.
- Parameterised queries only (EF Core LINQ, `@param`), never string concatenation; avoid
  `FromSqlRaw` with interpolated input (use `FromSql` with `FormattableString`).
- `datetime2`/`datetimeoffset` in UTC; `decimal` for money.
- Prod data never goes to nonprod or a laptop. Seed nonprod with fake data.

## Local development

Use SQL Server in a container (`mcr.microsoft.com/mssql/server:<pinned tag>`) with a local SA
password in `.env` and `Authentication=SqlPassword` **only when not on Azure**, or connect to the
nonprod database with `ActiveDirectoryDefault` if your account was given access. Never put the
local password into `platform.yaml`.

## Common mistakes

- `Login failed for user '<token-identified principal>'` → the identity has no database user yet,
  or the wrong client id is used. Check `AZURE_CLIENT_ID`; ask the platform team if it persists.
- Using `User Id=sa;Password=…` or a connection string secret → not supported on Azure.
- `privatelink.database.windows.net` in the host → always use `DATABASE_HOST` as given.
- Transient errors after a scale event → enable retries (`EnableRetryOnFailure`).
- Database checks in `/healthz` → put them in `/readyz`.
