import { z } from 'zod';
import { devUser, type User } from './auth/principal.js';

// All configuration comes from environment variables (app contract).
// Add new settings here, give them a safe default or make them optional,
// and document them in docs/architecture.md (Configuration table).

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const EnvSchema = z.object({
  // Set by the platform (do not set these in platform.yaml)
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CONTAINER_APP_NAME: optionalString, // set by Azure Container Apps; means "running on Azure"
  AZURE_CLIENT_ID: optionalString, // client id of the app's managed identity
  APPLICATIONINSIGHTS_CONNECTION_STRING: optionalString,
  DATABASE_HOST: optionalString,
  DATABASE_NAME: optionalString,
  DATABASE_USER: optionalString,
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  FRONT_DOOR_ID: optionalString,

  // Set by you in platform.yaml (runtime.env)
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Local development only: rejected when running on Azure
  DATABASE_PASSWORD: optionalString,
  DEV_FAKE_USER: optionalString,
  DEV_FAKE_ROLES: optionalString,
});

export type LogLevel = z.infer<typeof EnvSchema>['LOG_LEVEL'];

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  /** Local development only. On Azure the app signs in with its managed identity. */
  password?: string;
}

/**
 * Azure SQL: the platform sets DATABASE_HOST (<server>.database.windows.net) and DATABASE_NAME, and
 * no DATABASE_USER (the token names the identity). The app connects with mssql (db/azureSql.ts)
 * and runs T-SQL migrations (db/migrateAzureSql.ts); see the skill database-sql.
 */
export interface AzureSqlConfig {
  host: string;
  name: string;
}

export interface Config {
  port: number;
  logLevel: LogLevel;
  onAzure: boolean;
  azureClientId?: string;
  appInsightsConnectionString?: string;
  /** PostgreSQL (db/database.ts). */
  database?: DatabaseConfig;
  /** Azure SQL (db/azureSql.ts). */
  azureSql?: AzureSqlConfig;
  frontDoorId?: string;
  devUser: User | null;
}

export class ConfigError extends Error {}

/** Azure SQL server names in the Azure clouds. */
const AZURE_SQL_HOST = /\.database\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only names and reasons, never values: values may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  const onAzure = Boolean(e.CONTAINER_APP_NAME);
  const problems: string[] = [];

  if (onAzure && (e.DEV_FAKE_USER || e.DEV_FAKE_ROLES)) {
    problems.push('DEV_FAKE_USER/DEV_FAKE_ROLES must not be set on Azure');
  }
  if (onAzure && e.DATABASE_PASSWORD) {
    problems.push('DATABASE_PASSWORD must not be set on Azure (use the managed identity)');
  }

  let database: DatabaseConfig | undefined;
  let azureSql: AzureSqlConfig | undefined;
  if (e.DATABASE_HOST && AZURE_SQL_HOST.test(e.DATABASE_HOST)) {
    if (!e.DATABASE_NAME) problems.push('DATABASE_NAME is required when DATABASE_HOST is set');
    else azureSql = { host: e.DATABASE_HOST, name: e.DATABASE_NAME };
  } else if (e.DATABASE_HOST) {
    if (!e.DATABASE_NAME || !e.DATABASE_USER) {
      problems.push('DATABASE_NAME and DATABASE_USER are required when DATABASE_HOST is set');
    } else {
      database = {
        host: e.DATABASE_HOST,
        port: e.DATABASE_PORT,
        name: e.DATABASE_NAME,
        user: e.DATABASE_USER,
        password: e.DATABASE_PASSWORD,
      };
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }

  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    onAzure,
    azureClientId: e.AZURE_CLIENT_ID,
    appInsightsConnectionString: e.APPLICATIONINSIGHTS_CONNECTION_STRING,
    database,
    ...(azureSql ? { azureSql } : {}),
    frontDoorId: e.FRONT_DOOR_ID,
    devUser: devUser(e.DEV_FAKE_USER, e.DEV_FAKE_ROLES),
  };
}
