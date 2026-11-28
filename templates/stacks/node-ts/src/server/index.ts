import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadRoles } from './auth/roles.js';
import { loadConfig } from './config.js';
import { createAzureSql } from './db/azureSql.js';
import { createDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { migrateAzureSql } from './db/migrateAzureSql.js';
import { shutdownTelemetry } from './telemetry.js';

const SHUTDOWN_TIMEOUT_MS = 25_000; // the platform waits about 30 s after SIGTERM

function fatal(message: string, err: unknown): never {
  // The logger may not exist yet: write one JSON line by hand.
  const detail = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: message, err: detail })}\n`);
  process.exit(1);
}

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    return fatal('configuration error', err);
  }
})();

// The app's roles and their levels, written by the platform (the core's defaults without the file).
const appRoles = (() => {
  try {
    return loadRoles(resolve(process.cwd(), '.platform/roles.json'));
  } catch (err) {
    return fatal('roles error', err);
  }
})();

// The platform gives an app PostgreSQL or Azure SQL (or no database): config.ts tells them apart.
let migrated = config.database === undefined && config.azureSql === undefined;
const db = config.database
  ? createDatabase(config.database, config.azureClientId, (err) => app.log.error({ err }, 'database connection error'))
  : null;
const sqlDb = config.azureSql
  ? createAzureSql(config.azureSql, config.azureClientId, (err) => app.log.error({ err }, 'database connection error'))
  : null;
const anyDb = db ?? sqlDb;

const app = await buildApp({
  config,
  appRoles,
  readinessChecks: anyDb
    ? [
        () => {
          if (!migrated) throw new Error('migrations not finished');
        },
        () => anyDb.ping(),
      ]
    : [],
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    app.log.error('shutdown took too long, exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close(); // stops accepting requests, waits for running ones
    await anyDb?.close();
    await shutdownTelemetry();
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  // Listen first so /healthz answers while migrations run; /readyz stays 503 until done.
  await app.listen({ host: '0.0.0.0', port: config.port });
  if (db) {
    await migrate(db.pool, resolve(process.cwd(), 'migrations'), app.log);
    migrated = true;
  }
  if (sqlDb) {
    await sqlDb.connect();
    await migrateAzureSql(sqlDb.pool, resolve(process.cwd(), 'migrations'), app.log);
    migrated = true;
  }
} catch (err) {
  app.log.fatal({ err }, 'startup failed');
  process.exit(1);
}
