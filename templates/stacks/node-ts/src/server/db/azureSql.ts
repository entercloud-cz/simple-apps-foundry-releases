import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import sql from 'mssql';
import type { AzureSqlConfig } from '../config.js';

// Azure SQL access without passwords. The server allows Entra sign-in only: the app signs in
// as its managed identity, and the driver asks for a fresh access token for every new
// connection. Locally, DefaultAzureCredential uses your `az login` (only if your account was
// given access to the database). See the database-sql skill.

export interface AzureSqlDatabase {
  /** Connected after connect(): `db.pool.request().input('id', sql.Int, id).query('…')`. */
  pool: sql.ConnectionPool;
  /** Opens the pool (once). The app does this at startup, before the migrations. */
  connect(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createAzureSql(
  config: AzureSqlConfig,
  azureClientId: string | undefined,
  onError: (err: Error) => void,
): AzureSqlDatabase {
  // AZURE_CLIENT_ID is set on Azure: use exactly that managed identity.
  const credential: TokenCredential = azureClientId
    ? new ManagedIdentityCredential({ clientId: azureClientId })
    : new DefaultAzureCredential();
  const pool = new sql.ConnectionPool({
    server: config.host,
    database: config.name,
    port: 1433,
    authentication: { type: 'token-credential', options: { credential } },
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
  });
  // Errors on idle connections must not crash the process.
  pool.on('error', onError);

  return {
    pool,
    async connect() {
      if (!pool.connected && !pool.connecting) await pool.connect();
    },
    async ping() {
      await pool.request().query('SELECT 1');
    },
    async close() {
      await pool.close();
    },
  };
}
