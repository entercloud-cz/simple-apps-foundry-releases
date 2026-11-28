import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth/plugin.js';
import { levelOf, rolesOf, type AppRoles } from '../auth/roles.js';

// Example API routes, registered under /api. Add your own routes here or in new files next to
// this one. The default access policy (auth/access.ts) guards every one of them by its method and
// path: GET needs a role with the level read, POST/PUT/PATCH/DELETE write, /api/admin/** and
// /api/settings/** admin. Give every route validated input (a JSON `schema`).

export interface ApiOptions {
  appRoles: AppRoles;
}

export async function apiRoutes(app: FastifyInstance, { appRoles }: ApiOptions): Promise<void> {
  // Who am I? The user menu shows the name, the email and the roles with what each may do. Any
  // signed-in user may ask, also one without a role (the page then says so): access 'user'.
  app.get('/me', { config: { access: 'user' } }, async (request) => {
    const user = request.user!;
    return {
      id: user.id,
      name: user.name,
      email: user.email ?? null,
      roles: rolesOf(user, appRoles),
      level: levelOf(user, appRoles),
      isDevUser: request.isDevUser,
    };
  });

  // Under /api/admin: the policy lets only the admin level in. requireRole adds a finer rule on top
  // (here: exactly the Admin role); role values are defined in the portal.
  app.get('/admin/ping', { preHandler: requireRole('Admin') }, async () => ({
    message: 'pong (only users with the Admin role can see this)',
  }));

  // A POST: the policy needs the level write. Fastify rejects bodies that don't match the schema with 400.
  app.post<{ Body: { message: string } }>(
    '/echo',
    {
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: { message: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request) => ({ message: request.body.message }),
  );
}
