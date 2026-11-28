// saf:access-contract-test
//
// The contract test of the default access policy (src/server/auth/access.ts). It walks every
// registered /api route and checks who gets in, by level:
//   - not signed in: 401 everywhere but `public` routes;
//   - a user without a role (or only with roles that give no level): 403 everywhere but `user` and `public` routes;
//   - Reader (read): refused on every write and admin route;
//   - Editor (write): refused on every admin route;
//   - Admin: let through everywhere.
// A route's level is its own `config.access`, else the default below (the policy's table, written
// again here so that a change to the policy fails this test). Never skip or weaken this test:
// `platform check` (PC066) looks for it, and the delivery pipeline runs it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { ACCESS_REFUSED, listApiRoutes, type Access, type ApiRoute } from '../src/server/auth/access.js';
import { signedIn, TEST_ROLES, testConfig } from './helpers.js';

type Who = 'anonymous' | 'no role' | 'Reader' | 'Editor' | 'Admin';

const PEOPLE: Record<Who, Record<string, string>> = {
  anonymous: {},
  // Guest has no level and Stranger is not in the roles file: neither gives access.
  'no role': signedIn('Guest', 'Stranger'),
  Reader: signedIn('Reader'),
  Editor: signedIn('Editor'),
  Admin: signedIn('Admin'),
};

/** Who the policy lets through for each access, by the table in ADR-0078. */
const LET_THROUGH: Record<Access, Who[]> = {
  public: ['anonymous', 'no role', 'Reader', 'Editor', 'Admin'],
  user: ['no role', 'Reader', 'Editor', 'Admin'],
  read: ['Reader', 'Editor', 'Admin'],
  write: ['Editor', 'Admin'],
  admin: ['Admin'],
};

function defaultAccess(method: string, url: string): Access {
  if (/^\/api\/(admin|settings)(\/|$)/i.test(url)) return 'admin';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

/** A concrete URL for a route pattern: every parameter and wildcard becomes "1". */
function sampleUrl(pattern: string): string {
  return pattern.replace(/:[^/]+/g, '1').replace(/\*/g, '1');
}

/** A refusal by the policy, not by a stricter guard of the route itself (requireRole). */
function refusedByPolicy(res: LightMyRequestResponse, method: string): boolean {
  if (res.statusCode === 401) return true;
  // A HEAD response has no body to tell the policy's 403 from a guard's: only the refusals count there.
  if (res.statusCode !== 403 || method === 'HEAD') return false;
  return (res.json() as { error?: string }).error === ACCESS_REFUSED;
}

let app: FastifyInstance;
let routes: ApiRoute[];

beforeAll(async () => {
  app = await buildApp({ config: testConfig(), appRoles: TEST_ROLES });
  await app.ready();
  routes = listApiRoutes(app);
});
afterAll(async () => {
  await app.close();
});

describe('default access policy', () => {
  it('sees the routes', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toContainEqual({ method: 'GET', url: '/api/me', access: 'user' });
  });

  it('holds for every /api route and every level', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      const access = route.access ?? defaultAccess(route.method, route.url);
      const url = sampleUrl(route.url);
      for (const [who, headers] of Object.entries(PEOPLE) as [Who, Record<string, string>][]) {
        const res = await app.inject({ method: route.method as 'GET', url, headers });
        const allowed = LET_THROUGH[access].includes(who);
        if (allowed && refusedByPolicy(res, route.method)) {
          failures.push(`${route.method} ${route.url} (${access}): ${who} was refused with ${res.statusCode}`);
        }
        if (!allowed) {
          const expected = who === 'anonymous' ? 401 : 403;
          if (res.statusCode !== expected) {
            failures.push(`${route.method} ${route.url} (${access}): ${who} got ${res.statusCode}, expected ${expected}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
