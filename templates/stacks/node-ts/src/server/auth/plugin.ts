import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasAnyRole, parseClientPrincipal, PRINCIPAL_HEADER, type User } from './principal.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Signed-in user, or null for anonymous requests. Set on every request. */
    user: User | null;
  }
}

/**
 * Sets request.user from the platform's sign-in header. When the header is
 * missing (local development), falls back to the DEV_FAKE_USER mock, which
 * config.ts refuses to enable on Azure.
 */
export function registerAuth(app: FastifyInstance, devUser: User | null): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = parseClientPrincipal(request.headers[PRINCIPAL_HEADER]) ?? devUser;
  });
}

/** Route guard: the user must be signed in. Use as `preHandler: requireUser`. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'Sign-in required' });
  }
}

/** Route guard: the user must have at least one of the given app roles. */
export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      await reply.code(401).send({ error: 'Sign-in required' });
    } else if (!hasAnyRole(request.user, roles)) {
      await reply.code(403).send({ error: 'You do not have permission to do this' });
    }
  };
}
