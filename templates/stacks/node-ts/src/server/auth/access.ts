import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { levelAllows, levelOf, type AppRoles, type Level } from './roles.js';

// saf:access-policy
//
// The app's default access policy, on every /api route, deny by default:
//
//   GET, HEAD                                  needs the level read
//   POST, PUT, PATCH, DELETE (any other)       needs write
//   /api/admin/**, /api/settings/** (any)      needs admin
//   signed in, but no role with a level        refused (403)
//   not signed in                              401
//
// A route says otherwise only in its own declaration, so a reviewer sees every exception:
//
//   app.get('/me', { config: { access: 'user' } }, handler)    // any signed-in user, even without a role
//   app.post('/search', { config: { access: 'read' } }, handler) // a read sent as POST
//
//   'read' | 'write' | 'admin'   that level
//   'user'                       any signed-in user, whatever their roles
//   'public'                     no sign-in at all: only an anonymous app or a deliberately public endpoint
//
// Never weaken or remove this policy; declare an exception on its route only with the user's OK and
// record it in docs/architecture.md. test/accessContract.test.ts checks every route against it.
// Guards such as requireRole('Admin') still work on top of it, for finer rules.

export type Access = Level | 'user' | 'public';
export const ACCESS_VALUES: readonly Access[] = ['read', 'write', 'admin', 'user', 'public'];

/** The 403 body's message when this policy refuses a request (tests tell it from other 403s). */
export const ACCESS_REFUSED = 'Your role in this app does not allow this';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Who may call this route, instead of the default policy (see auth/access.ts). */
    access?: Access;
  }
  interface FastifyInstance {
    /** Every /api route with its declared access, collected as routes are registered. */
    apiRoutes: ApiRoute[];
  }
}

/** A registered /api route and its declared access (undefined: the default policy). */
export interface ApiRoute {
  method: string;
  url: string;
  access?: Access;
}

const READ_METHODS = new Set(['GET', 'HEAD']);
const ADMIN_PREFIXES = ['/api/admin', '/api/settings'];

/** The path without query, with %xx decoded, repeated slashes collapsed and lower case: for checks only. */
function normalizePath(url: string): string {
  let path = url.split('?')[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it as it is: a malformed path is checked as written
  }
  return path.replace(/\/{2,}/g, '/').toLowerCase();
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isApiPath(url: string): boolean {
  return underPrefix(normalizePath(url), '/api');
}

/** What a request needs: the route's declared access, else the default for its method and path. */
export function requiredAccess(method: string, paths: string[], declared: Access | undefined): Access {
  if (declared) return declared;
  const normalized = paths.map(normalizePath);
  if (normalized.some((p) => ADMIN_PREFIXES.some((prefix) => underPrefix(p, prefix)))) return 'admin';
  return READ_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
}

/** Every registered /api route (for the contract test). */
export function listApiRoutes(app: FastifyInstance): ApiRoute[] {
  return [...app.apiRoutes];
}

/**
 * Installs the policy. Call it right after registerAuth (it needs request.user) and before any
 * route is registered.
 */
export function registerAccessPolicy(app: FastifyInstance, appRoles: AppRoles): void {
  app.decorate('apiRoutes', [] as ApiRoute[]);

  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    if (access !== undefined && !ACCESS_VALUES.includes(access)) {
      // A typo must not open or close a route silently: the app refuses to start.
      throw new Error(`Route ${route.url}: config.access must be one of ${ACCESS_VALUES.join(', ')}`);
    }
    if (!isApiPath(route.url)) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) app.apiRoutes.push({ method, url: route.url, access });
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // routeOptions.url is the matched route's pattern (undefined or a wildcard when nothing matched);
    // request.url is what the client sent. Either one under /api puts the request under the policy.
    const routeUrl = request.routeOptions.url;
    const paths = routeUrl ? [routeUrl, request.url] : [request.url];
    if (!paths.some(isApiPath)) return;

    const needed = requiredAccess(request.method, paths, request.routeOptions.config.access);
    if (needed === 'public') return;
    if (!request.user) {
      return reply.code(401).send({ error: 'Sign-in required' });
    }
    if (needed === 'user') return;
    if (!levelAllows(levelOf(request.user, appRoles), needed)) {
      return reply.code(403).send({ error: ACCESS_REFUSED });
    }
  });
}
