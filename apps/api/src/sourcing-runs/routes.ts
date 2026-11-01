import type { FieldError } from '@listora/api-contract';
import { inTransaction } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { insertExpenses } from '../expenses/repository.ts';
import { sourcingSpendValues } from '../expenses/values.ts';
import { createHaulWithItems } from '../hauls/membership.ts';
import { keepAsItem } from '../scans/keep.ts';
import { keptScans, lockScans } from '../scans/repository.ts';
import {
  assertThriftScanOn,
  endRun,
  findRun,
  insertRun,
  lockRun,
  markCheckedOut,
  runView,
} from './repository.ts';
import { loadRunSummary } from './summary.ts';

export interface SourcingRunRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * Sourcing runs (docs/features/thrift-scan.md): `createSourcingRun` starts a trip to a store,
 * `endSourcingRun` ends it, `checkoutSourcingRun` turns its kept items into a haul at the
 * register, and `getSourcingRunSummary` shows what it came to. Only for an account the thrift
 * scan is on for.
 */
export function registerSourcingRunRoutes(
  app: FastifyInstance,
  deps: SourcingRunRouteDependencies,
): void {
  contractRoute(app, deps, 'createSourcingRun', async ({ tenant, db, body }) => {
    await assertThriftScanOn(db, tenant);
    const run = await insertRun(db, tenant, cleanPlace(body.place));
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

  contractRoute(app, deps, 'checkoutSourcingRun', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      await assertThriftScanOn(trx, tenant);
      const now = deps.now();
      if (body.total.amountCents < 0) {
        throw validationFailed([{ field: 'total.amountCents', message: 'must not be negative' }]);
      }
      // The scans first, then the run: the order `keepScan` takes them in.
      const scans = await lockScans(trx, tenant, body.keptScanIds);
      const run = await lockRun(trx, tenant, params.runId);
      if (!run) throw notFound('Run');
      if (run.checked_out_at !== null) {
        throw new ApiError('invalid_state_transition', 'This run was already checked out.');
      }
      if (run.ended_at !== null) {
        throw new ApiError(
          'invalid_state_transition',
          'This run ended, so it can no longer be checked out.',
        );
      }
      const errors: FieldError[] = [];
      for (const [index, scanId] of body.keptScanIds.entries()) {
        const field = `keptScanIds[${String(index)}]`;
        const scan = scans.get(scanId);
        if (scan?.run_id !== run.id) {
          errors.push({ field, message: 'is not a scan of this run' });
        } else if (scan.decision === 'replaced') {
          errors.push({ field, message: 'was replaced by a later scan of the item' });
        } else if (scan.decision === 'skipped') {
          errors.push({ field, message: 'was skipped' });
        }
      }
      if (errors.length > 0) throw validationFailed(errors);
      // A kept scan whose item the app has not sent yet is kept now; its `keepScan` answers it.
      for (const scanId of body.keptScanIds) {
        const scan = scans.get(scanId);
        if (scan?.decision === 'undecided') await keepAsItem(trx, tenant, scan);
      }

      // The listed scans' items in the order kept, then any other the server kept.
      const kept = await keptScans(trx, tenant, run.id);
      const order = new Map(body.keptScanIds.map((id, index) => [id, index]));
      const itemIds = kept
        .map((scan, index) => ({
          scan,
          rank: order.get(scan.id) ?? body.keptScanIds.length + index,
        }))
        .sort((a, b) => a.rank - b.rank)
        .map(({ scan }) => scan.item_id);
      const place = cleanPlace(body.place) ?? run.place;
      const haul = await createHaulWithItems(
        trx,
        tenant,
        {
          total_cents: body.total.amountCents,
          currency: body.total.currency,
          item_count: body.itemCount,
          purchase_date: body.purchaseDate ?? run.started_at.toISOString().slice(0, 10),
          purchase_source: place,
        },
        itemIds,
        'keptScanIds',
        now,
      );
      await endRun(trx, tenant, run, now);
      // The trip's miles and other spend, as expenses of the haul's day (docs/features/expenses.md).
      const tripDay = haul.purchase_date ?? run.started_at.toISOString().slice(0, 10);
      await insertExpenses(trx, tenant, [
        ...(body.miles !== undefined && body.miles > 0
          ? [
              {
                incurredOn: tripDay,
                category: 'Mileage',
                description: place,
                amountCents: null,
                miles: body.miles,
                sourcingRunId: run.id,
              },
            ]
          : []),
        ...sourcingSpendValues(body.otherSpend ?? [], tripDay, run.id),
      ]);
      const checkedOut = await markCheckedOut(trx, tenant, run.id, {
        haulId: haul.id,
        place,
        miles: body.miles ?? null,
        at: now,
      });
      return { status: 201, body: await loadRunSummary(trx, tenant, checkedOut) };
    }),
  );

  contractRoute(app, deps, 'getSourcingRunSummary', async ({ tenant, db, params }) => {
    await assertThriftScanOn(db, tenant);
    const run = await findRun(db, tenant, params.runId);
    if (!run) throw notFound('Run');
    return { status: 200, body: await loadRunSummary(db, tenant, run) };
  });
}

/** The place as the seller named it, spaces tidied; null when they named none. */
function cleanPlace(place: string | undefined): string | null {
  const cleaned = place?.trim().replace(/\s+/g, ' ');
  return cleaned === undefined || cleaned === '' ? null : cleaned;
}
