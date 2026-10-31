import { inTransaction } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound } from '../errors.ts';
import { assertThriftScanOn, endRun, insertRun, lockRun, runView } from './repository.ts';

export interface SourcingRunRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * Sourcing runs (docs/features/thrift-scan.md): `createSourcingRun` starts a trip to a store,
 * `endSourcingRun` ends it. Only for an account the thrift scan is on for.
 */
export function registerSourcingRunRoutes(
  app: FastifyInstance,
  deps: SourcingRunRouteDependencies,
): void {
  contractRoute(app, deps, 'createSourcingRun', async ({ tenant, db, body }) => {
    await assertThriftScanOn(db, tenant);
    const place = body.place?.trim().replace(/\s+/g, ' ');
    const run = await insertRun(db, tenant, place === '' ? undefined : place);
    return { status: 201, body: runView(run) };
  });

  contractRoute(app, deps, 'endSourcingRun', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      await assertThriftScanOn(trx, tenant);
      const run = await lockRun(trx, tenant, params.runId);
      if (!run) throw notFound('Run');
      return { status: 200, body: runView(await endRun(trx, tenant, run, deps.now())) };
    }),
  );
}
