import type { FastifyInstance } from 'fastify';
import { HEALTH_PATHS } from './routes/health.js';

/**
 * When the app is served through Azure Front Door, the platform sets FRONT_DOOR_ID.
 * Requests must then carry that id in X-Azure-FDID; anything else did not come
 * through our Front Door and is rejected. Health probes come from the platform
 * directly and are exempt. Sign-in (/.auth/*) is handled before the app and is
 * not covered by this check.
 */
export function registerFrontDoorCheck(app: FastifyInstance, expectedId: string | undefined): void {
  if (!expectedId) return;
  const expected = expectedId.toLowerCase();

  app.addHook('onRequest', async (request, reply) => {
    if (HEALTH_PATHS.has(request.url.split('?')[0] ?? '')) return;
    const header = request.headers['x-azure-fdid'];
    const ids = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((id) => id.trim().toLowerCase());
    if (!ids.includes(expected)) {
      request.log.warn('request rejected: missing or wrong X-Azure-FDID');
      await reply.code(403).send({ error: 'Forbidden' });
    }
  });
}
