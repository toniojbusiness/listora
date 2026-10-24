import { fastify, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { registerHealthRoutes, type HealthDependencies } from './health.ts';

export interface AppDependencies extends HealthDependencies {
  /** A `createLogger()` instance from @listora/shared. Omit in tests to keep output quiet. */
  logger?: FastifyBaseLogger;
}

/** Builds the Fastify app without listening, so tests can drive it with `app.inject`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
  });
  registerHealthRoutes(app, deps);
  return app;
}
