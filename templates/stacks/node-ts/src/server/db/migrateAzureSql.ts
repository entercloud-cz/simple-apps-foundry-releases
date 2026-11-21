import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import sql from 'mssql';

// Minimal migration runner for Azure SQL (T-SQL). Applies migrations/NNNN_description.sql
// files in name order, once each, and records them in dbo.schema_migrations. All pending
// files run in one transaction that holds an application lock, so only one replica migrates
// at a time and a failed file leaves the database as it was.
//
// A line with only GO splits a file into batches (as in SQL Server tools), for statements
// that must start a batch, such as CREATE VIEW.
//
// Rules (see the database-sql skill):
// - Never edit or rename a migration that has been pushed. Add a new one.
// - Changes must be backward compatible (expand/contract): the previous release
//   must keep working against the new schema, because rollback reuses it.

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_TIMEOUT_MS = 120_000;

/** The batches of a migration file: split on lines that hold only GO; empty batches dropped. */
export function splitBatches(text: string): string[] {
  return text
    .split(/^[ \t]*GO[ \t]*\r?$/gim)
    .map((batch) => batch.trim())
    .filter((batch) => batch.length > 0);
}

export async function migrateAzureSql(pool: sql.ConnectionPool, dir: string, log: FastifyBaseLogger): Promise<void> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => MIGRATION_FILE.test(f)).sort();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  const done: string[] = [];
  let current = '';
  try {
    const lock = await new sql.Request(tx)
      .input('timeout', sql.Int, LOCK_TIMEOUT_MS)
      .query<{ result: number }>(
        "DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'schema_migrations', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = @timeout; SELECT @r AS result",
      );
    if ((lock.recordset[0]?.result ?? -1) < 0) throw new Error('Another replica holds the migration lock');
    await new sql.Request(tx).batch(
      "IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL CREATE TABLE dbo.schema_migrations (id nvarchar(200) NOT NULL PRIMARY KEY, applied_at datetime2 NOT NULL CONSTRAINT df_schema_migrations_applied_at DEFAULT SYSUTCDATETIME())",
    );
    const { recordset } = await new sql.Request(tx).query<{ id: string }>('SELECT id FROM dbo.schema_migrations');
    const applied = new Set(recordset.map((r) => r.id));

    for (const file of files) {
      if (applied.has(file)) continue;
      current = file;
      for (const batch of splitBatches(await readFile(join(dir, file), 'utf8'))) {
        await new sql.Request(tx).batch(batch);
      }
      await new sql.Request(tx).input('id', sql.NVarChar(200), file).query('INSERT INTO dbo.schema_migrations (id) VALUES (@id)');
      done.push(file);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw new Error(current ? `Migration ${current} failed` : 'Migrations failed', { cause: err });
  }
  for (const file of done) log.info({ migration: file }, 'migration applied');
}
