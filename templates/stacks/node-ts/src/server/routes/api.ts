import type { FastifyInstance } from 'fastify';
import { requireRole, requireUser } from '../auth/plugin.js';

// Example API routes, registered under /api. Add your own routes here or in new
// files next to this one. Every route that touches data needs a guard
// (requireUser or requireRole) and validated input (a JSON `schema`).

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Who am I? Used by the frontend to show the user's name and what they may do.
  app.get('/me', { preHandler: requireUser }, async (request) => {
    const { name, email, roles } = request.user!;
    return { name, email, roles };
  });

  // Example of a role-protected route. Role values are defined in the portal.
  app.get('/admin/ping', { preHandler: requireRole('Admin') }, async () => ({
    message: 'pong (only users with the Admin role can see this)',
  }));

  // Example of input validation: Fastify rejects bodies that don't match the schema with 400.
  app.post<{ Body: { message: string } }>(
    '/echo',
    {
      preHandler: requireUser,
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
