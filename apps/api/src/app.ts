import { randomUUID } from 'node:crypto';

import type { Db } from '@listora/db';
import { fastify, LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { AuthDriver } from './auth/driver.ts';
import { registerErrorHandling } from './errors.ts';
import { registerHealthRoutes, type HealthDependencies } from './health.ts';
import { registerItemRoutes } from './items/routes.ts';
import { registerPhotoRoutes } from './photos/routes.ts';
import { noPhotoUploads, type PhotoUploads } from './photos/uploads.ts';

export interface AppDependencies extends HealthDependencies {
  db: Db;
  auth: AuthDriver;
  /** Where attached photo files come from; T-07 provides upload sessions. */
  uploads?: PhotoUploads;
  /** A `createLogger()` instance from @listora/shared. Omit in tests to keep output quiet. */
  logger?: FastifyBaseLogger;
}

export const REQUEST_ID_HEADER = 'x-request-id';
/** A caller's request id is reused when it looks like one (a proxy's or the app's own). */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Builds the Fastify app without listening, so tests can drive it with `app.inject`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    // Every log line of a request carries `requestId`, the same id as the response header and
    // `error.requestId`, so a support report leads straight to the server logs.
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (request) => {
      const incoming = request.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && ACCEPTED_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });
  // Every body is JSON; without this, Fastify would hand a text/plain body to validation.
  app.removeContentTypeParser('text/plain');
  app.decorateRequest('tenant', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
  closeKeepAliveConnectionsOnShutdown(app);
  registerErrorHandling(app);

  registerHealthRoutes(app, deps);
  deps.auth.registerRoutes?.(app);
  const routeDeps = { db: deps.db, auth: deps.auth };
  registerItemRoutes(app, routeDeps);
  registerPhotoRoutes(app, { ...routeDeps, uploads: deps.uploads ?? noPhotoUploads });
  return app;
}

/**
 * `app.close()` waits for every open connection. A keep-alive connection whose request was
 * still running when shutdown began would otherwise stay open after its response until the
 * client or the keep-alive timeout closes it, stalling shutdown past the task's stop timeout.
 * Responses sent during shutdown therefore ask the client to close the connection.
 */
function closeKeepAliveConnectionsOnShutdown(app: FastifyInstance): void {
  let closing = false;
  app.addHook('preClose', (done) => {
    closing = true;
    done();
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (closing) reply.header('connection', 'close');
    return payload;
  });
}
