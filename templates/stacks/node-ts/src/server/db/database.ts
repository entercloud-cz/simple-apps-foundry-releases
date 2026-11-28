import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type AccessToken,
  type TokenCredential,
} from '@azure/identity';
import pg from 'pg';
import type { DatabaseConfig } from '../config.js';

// PostgreSQL access without passwords. On Azure the app signs in to the database
// with its managed identity: the "password" is a short-lived Entra access token.
// Locally you can point DATABASE_* at a local PostgreSQL with DATABASE_PASSWORD,
// or (if your account has access) at a cloud database after `az login`.

const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

export interface Database {
  pool: pg.Pool;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function entraTokenProvider(azureClientId: string | undefined): () => Promise<string> {
  // AZURE_CLIENT_ID is set on Azure: use exactly that managed identity.
  // Without it (your laptop), DefaultAzureCredential uses your `az login`.
  const credential: TokenCredential = azureClientId
    ? new ManagedIdentityCredential({ clientId: azureClientId })
    : new DefaultAzureCredential();
  let cached: AccessToken | null = null;

  return async () => {
    if (!cached || cached.expiresOnTimestamp - Date.now() < REFRESH_BEFORE_EXPIRY_MS) {
      cached = await credential.getToken(POSTGRES_SCOPE);
      if (!cached) throw new Error('Could not get an access token for the database');
    }
    return cached.token;
  };
}

export function createDatabase(
  config: DatabaseConfig,
  azureClientId: string | undefined,
  onError: (err: Error) => void,
): Database {
  const usePassword = config.password !== undefined;
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    // pg calls this for every new connection, so tokens are refreshed automatically.
    password: usePassword ? config.password : entraTokenProvider(azureClientId),
    // Azure requires TLS; a local development database usually has none.
    ssl: usePassword ? false : { rejectUnauthorized: true },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Errors on idle connections (e.g. a server restart) must not crash the process.
  pool.on('error', onError);

  return {
    pool,
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
