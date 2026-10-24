import type { FastifyInstance } from 'fastify';

export interface HealthDependencies {
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
}

/**
 * `/health/live`: the process is up (no dependencies; for container liveness).
 * `/health/ready`: the process can serve traffic (database reachable; for load balancers).
 * Responses never include error details; failures are logged server-side.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get('/health/live', () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    try {
      await deps.pingDatabase();
      return { status: 'ok', checks: { database: 'ok' } };
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'unavailable', checks: { database: 'unavailable' } });
    }
  });
}
