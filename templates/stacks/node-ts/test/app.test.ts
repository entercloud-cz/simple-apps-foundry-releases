import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/server/app.js';
import { principalHeader, signedIn, TEST_ROLES, testConfig } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(options: Partial<AppOptions> = {}): Promise<FastifyInstance> {
  return buildApp({ config: testConfig(), appRoles: TEST_ROLES, ...options });
}

describe('health endpoints', () => {
  it('answers /healthz and /readyz', async () => {
    app = await build();
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).statusCode).toBe(200);
  });

  it('reports not ready when a readiness check fails', async () => {
    app = await build({
      readinessChecks: [
        () => {
          throw new Error('database down');
        },
      ],
    });
    expect((await app.inject('/readyz')).statusCode).toBe(503);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});

describe('sign-in and roles', () => {
  it('rejects anonymous requests to protected routes', async () => {
    app = await build();
    expect((await app.inject('/api/me')).statusCode).toBe(401);
  });

  it('returns the signed-in user with their roles and level', async () => {
    app = await build();
    const res = await app.inject({ url: '/api/me', headers: signedIn('Reader', 'Guest', 'Stranger') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Test User',
      email: 'jana@contoso.com',
      roles: [
        { value: 'Reader', displayName: 'Reader', description: 'Can see the data.', level: 'read' },
        { value: 'Guest', displayName: 'Guest', description: 'Has no level yet.', level: null },
      ],
      level: 'read',
      isDevUser: false,
    });
  });

  it('answers /api/me for a user without a role, so the page can say so', async () => {
    app = await build();
    const res = await app.inject({ url: '/api/me', headers: signedIn() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ roles: [], level: null });
  });

  it('enforces roles', async () => {
    app = await build();
    expect((await app.inject({ url: '/api/admin/ping', headers: signedIn('Reader') })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/admin/ping', headers: signedIn('Admin') })).statusCode).toBe(200);
  });

  it('uses the dev mock user when there is no header', async () => {
    app = await build({ config: testConfig({ devUser: { id: 'dev', name: 'dev', roles: ['Admin'] } }) });
    expect((await app.inject('/api/admin/ping')).statusCode).toBe(200);
    expect((await app.inject('/api/me')).json()).toMatchObject({ name: 'dev', level: 'admin', isDevUser: true });
  });

  it('validates input', async () => {
    app = await build();
    const headers = signedIn('Editor');
    const bad = await app.inject({ method: 'POST', url: '/api/echo', headers, payload: { message: '' } });
    const good = await app.inject({ method: 'POST', url: '/api/echo', headers, payload: { message: 'hi' } });
    expect(bad.statusCode).toBe(400);
    expect(good.json()).toEqual({ message: 'hi' });
  });

  it('refuses a typo in a route access declaration at start', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerAccessPolicy } = await import('../src/server/auth/access.js');
    app = Fastify();
    registerAccessPolicy(app, TEST_ROLES);
    expect(() =>
      // @ts-expect-error: 'pubilc' is not an access value
      app!.get('/api/x', { config: { access: 'pubilc' } }, async () => ({})),
    ).toThrow(/config.access/);
  });
});

describe('security', () => {
  it('sends security headers', async () => {
    app = await build();
    const res = await app.inject('/healthz');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects requests that did not come through our Front Door', async () => {
    const frontDoorId = '22222222-2222-2222-2222-222222222222';
    app = await build({ config: testConfig({ frontDoorId }) });
    const headers = { 'x-ms-client-principal': principalHeader() };
    expect((await app.inject({ url: '/api/me', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/me', headers: { ...headers, 'x-azure-fdid': frontDoorId } })).statusCode).toBe(200);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});
