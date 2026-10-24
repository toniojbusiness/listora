import type { HealthLive, HealthReady } from '@listora/api-contract';
import type { FastifyInstance } from 'fastify';

export interface HealthDependencies {
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
}

/**
 * `/health/live`: the process is up (no dependencies). The load balancer health check uses
 * it, and ECS replaces tasks that fail that check, so it must not depend on the database: a
 * database failover would otherwise restart every API task at once.
 * `/health/ready`: the process can serve traffic (database reachable). For deploy checks,
 * smoke tests, and operators diagnosing an outage; nothing replaces tasks on it.
 * Responses never include error details; failures are logged server-side.
 * Reply types come from the API contract (packages/api-contract/openapi.yaml).
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get<{ Reply: HealthLive }>('/health/live', () => ({ status: 'ok' }));

  app.get<{ Reply: HealthReady }>('/health/ready', async (request, reply) => {
    try {
      await deps.pingDatabase();
      return { status: 'ok', checks: { database: 'ok' } };
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'unavailable', checks: { database: 'unavailable' } });
    }
  });
}
