import { inTransaction } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import { findUploadSession, insertUploadSession } from './repository.ts';
import { UPLOAD_SESSION_TTL_MS, uploadSessionView } from './uploads.ts';

export interface UploadRouteDependencies extends RouteDependencies {
  storage: ObjectStorage;
  now: () => Date;
}

/**
 * Upload sessions: `createUploadSession` and `getUploadSession`. The client sends file bytes
 * straight to storage with each file's upload target; `addItemPhoto` then attaches them.
 */
export function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDependencies): void {
  contractRoute(app, deps, 'createUploadSession', async ({ tenant, db, body }) =>
    inTransaction(db, async (trx) => {
      const now = deps.now();
      const session = await insertUploadSession(
        trx,
        tenant,
        new Date(now.getTime() + UPLOAD_SESSION_TTL_MS),
        body.files,
      );
      return {
        status: 201,
        // Nothing can have been uploaded to a session that did not exist a moment ago.
        body: await uploadSessionView(trx, deps.storage, tenant, session, {
          now,
          checkPending: false,
        }),
      };
    }),
  );

  contractRoute(app, deps, 'getUploadSession', async ({ tenant, db, params }) => {
    const session = await findUploadSession(db, tenant, params.sessionId);
    if (!session) throw notFound('Upload session');
    return {
      status: 200,
      body: await uploadSessionView(db, deps.storage, tenant, session, {
        now: deps.now(),
        checkPending: true,
      }),
    };
  });
}
