import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { principalHeader, testConfig } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health endpoints', () => {
  it('answers /healthz and /readyz', async () => {
    app = await buildApp({ config: testConfig() });
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).statusCode).toBe(200);
  });

  it('reports not ready when a readiness check fails', async () => {
    app = await buildApp({
      config: testConfig(),
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
    app = await buildApp({ config: testConfig() });
    expect((await app.inject('/api/me')).statusCode).toBe(401);
  });

  it('returns the signed-in user', async () => {
    app = await buildApp({ config: testConfig() });
    const res = await app.inject({ url: '/api/me', headers: { 'x-ms-client-principal': principalHeader({ roles: ['Reader'] }) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Test User', roles: ['Reader'] });
  });

  it('enforces roles', async () => {
    app = await buildApp({ config: testConfig() });
    const asReader = await app.inject({ url: '/api/admin/ping', headers: { 'x-ms-client-principal': principalHeader({ roles: ['Reader'] }) } });
    const asAdmin = await app.inject({ url: '/api/admin/ping', headers: { 'x-ms-client-principal': principalHeader({ roles: ['Admin'] }) } });
    expect(asReader.statusCode).toBe(403);
    expect(asAdmin.statusCode).toBe(200);
  });

  it('uses the dev mock user when there is no header', async () => {
    app = await buildApp({ config: testConfig({ devUser: { id: 'dev', name: 'dev', roles: ['Admin'] } }) });
    expect((await app.inject('/api/admin/ping')).statusCode).toBe(200);
  });

  it('validates input', async () => {
    app = await buildApp({ config: testConfig() });
    const headers = { 'x-ms-client-principal': principalHeader() };
    const bad = await app.inject({ method: 'POST', url: '/api/echo', headers, payload: { message: '' } });
    const good = await app.inject({ method: 'POST', url: '/api/echo', headers, payload: { message: 'hi' } });
    expect(bad.statusCode).toBe(400);
    expect(good.json()).toEqual({ message: 'hi' });
  });
});

describe('security', () => {
  it('sends security headers', async () => {
    app = await buildApp({ config: testConfig() });
    const res = await app.inject('/healthz');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects requests that did not come through our Front Door', async () => {
    const frontDoorId = '22222222-2222-2222-2222-222222222222';
    app = await buildApp({ config: testConfig({ frontDoorId }) });
    const headers = { 'x-ms-client-principal': principalHeader() };
    expect((await app.inject({ url: '/api/me', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/me', headers: { ...headers, 'x-azure-fdid': frontDoorId } })).statusCode).toBe(200);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});
