import { randomUUID } from 'node:crypto';

import type { AiClient } from '@listora/ai';
import type { AnalysisJobQueue } from '@listora/analysis';
import type { Db } from '@listora/db';
import type { PhotoJobQueue } from '@listora/photos';
import { LocalDiskStorage, type ObjectStorage } from '@listora/storage';
import { fastify, LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { registerAnalysisRoutes } from './analyses/routes.ts';
import type { AuthDriver } from './auth/driver.ts';
import { registerErrorHandling } from './errors.ts';
import { registerHealthRoutes, type HealthDependencies } from './health.ts';
import { registerItemRoutes } from './items/routes.ts';
import { registerPhotoRoutes } from './photos/routes.ts';
import type { PhotoUploads } from './photos/uploads.ts';
import { registerPricingRoutes } from './pricing/routes.ts';
import { registerLocalStorageRoutes } from './storage/local-routes.ts';
import { registerUploadRoutes } from './uploads/routes.ts';
import { SessionPhotoUploads } from './uploads/uploads.ts';

export interface AppDependencies extends HealthDependencies {
  db: Db;
  auth: AuthDriver;
  /** Photo uploads and derived images. The local driver's routes are served by this app. */
  storage: ObjectStorage;
  /** Where `addItemPhoto` adds each new photo's processing job. */
  photoJobs: PhotoJobQueue;
  /** The AI client whose guards analysis requests are checked against (it is never called). */
  ai: AiClient;
  /** Where starting or escalating an analysis adds its job. */
  analysisJobs: AnalysisJobQueue;
  /** Where attached photo files come from; defaults to upload sessions in `storage`. */
  uploads?: PhotoUploads;
  /** The clock upload sessions expire by. */
  now?: () => Date;
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
  if (deps.storage instanceof LocalDiskStorage) registerLocalStorageRoutes(app, deps.storage);
  const now = deps.now ?? (() => new Date());
  const routeDeps = { db: deps.db, auth: deps.auth, storage: deps.storage };
  registerItemRoutes(app, routeDeps);
  registerUploadRoutes(app, { ...routeDeps, now });
  registerPhotoRoutes(app, {
    ...routeDeps,
    uploads: deps.uploads ?? new SessionPhotoUploads(deps.storage, now),
    photoJobs: deps.photoJobs,
  });
  registerPricingRoutes(app, routeDeps);
  registerAnalysisRoutes(app, {
    ...routeDeps,
    ai: deps.ai,
    analysisJobs: deps.analysisJobs,
    now,
  });
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
