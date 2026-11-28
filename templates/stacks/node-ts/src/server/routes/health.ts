import type { FastifyInstance } from 'fastify';

export const HEALTH_PATHS = new Set(['/healthz', '/readyz']);

/** A readiness check throws (or rejects) when a dependency the app needs is not usable. */
export type ReadinessCheck = () => Promise<void> | void;

const CHECK_TIMEOUT_MS = 3000;

function withTimeout(check: ReadinessCheck): Promise<void> {
  return Promise.race([
    Promise.resolve().then(check),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

export function registerHealthRoutes(app: FastifyInstance, checks: ReadinessCheck[]): void {
  // Liveness: is the process alive? Never check databases or other services here,
  // or an outage elsewhere makes the platform restart a healthy container.
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Readiness: can this replica serve traffic right now (database reachable,
  // migrations done)? The platform sends traffic only to ready replicas.
  app.get('/readyz', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await Promise.all(checks.map(withTimeout));
      return { status: 'ready' };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'not ready' });
    }
  });
}
