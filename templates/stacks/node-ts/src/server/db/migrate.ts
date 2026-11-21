import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';

// Minimal migration runner. Applies migrations/NNNN_description.sql files in
// name order, once each, and records them in the schema_migrations table.
// An advisory lock makes sure only one replica migrates at a time.
//
// Rules (see the database-postgres skill):
// - Never edit or rename a migration that has been pushed. Add a new one.
// - Changes must be backward compatible (expand/contract): the previous release
//   must keep working against the new schema, because rollback reuses it.

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_ID = 727_001; // any constant; identifies "migrations" for pg_advisory_lock

export async function migrate(pool: pg.Pool, dir: string, log: FastifyBaseLogger): Promise<void> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info({ migration: file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
