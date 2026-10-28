import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';

import { requestSync, syncStatus } from './sync.ts';

/** Sync (docs/features/sync.md): read-only checks of every linked marketplace, now. */
export function registerSyncRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  contractRoute(app, deps, 'getSyncStatus', async ({ tenant, db }) => ({
    status: 200,
    body: { data: await syncStatus(db, tenant.accountId) },
  }));

  contractRoute(app, deps, 'requestSync', async ({ tenant, db }) => {
    await requestSync(db, { accountId: tenant.accountId });
    return { status: 200, body: { data: await syncStatus(db, tenant.accountId) } };
  });
}
