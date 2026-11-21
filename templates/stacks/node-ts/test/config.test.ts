import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/server/config.js';

describe('loadConfig', () => {
  it('uses defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 8080, logLevel: 'info', onAzure: false, devUser: null });
    expect(config.database).toBeUndefined();
  });

  it('refuses the dev mock user on Azure', () => {
    expect(() => loadConfig({ CONTAINER_APP_NAME: 'app', DEV_FAKE_USER: 'dev@contoso.com' })).toThrow(ConfigError);
  });

  it('requires all database settings together', () => {
    expect(() => loadConfig({ DATABASE_HOST: 'db.example' })).toThrow(/DATABASE_NAME/);
    expect(loadConfig({ DATABASE_HOST: 'db.example', DATABASE_NAME: 'app', DATABASE_USER: 'id-app' }).database).toMatchObject({
      host: 'db.example',
      port: 5432,
    });
  });

  it('Azure SQL (no DATABASE_USER): the Azure SQL code, not the PostgreSQL code', () => {
    const config = loadConfig({ DATABASE_HOST: 'sql-contoso-app-dev-a1b2c3.database.windows.net', DATABASE_NAME: 'sqldb-app' });
    expect(config.database).toBeUndefined();
    expect(config.azureSql).toEqual({ host: 'sql-contoso-app-dev-a1b2c3.database.windows.net', name: 'sqldb-app' });
    expect(() => loadConfig({ DATABASE_HOST: 'sql-contoso-app-dev-a1b2c3.database.windows.net' })).toThrow(/DATABASE_NAME/);
  });
});
