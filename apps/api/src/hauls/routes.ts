import { inTransaction } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound, validationFailed } from '../errors.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import { addItems, createHaulWithItems } from './membership.ts';
import {
  findHaul,
  haulMemberCounts,
  leaveHaul,
  listHaulRows,
  lockHauls,
  lockItemsById,
  settleHaul,
  updateHaul,
  type HaulValues,
} from './repository.ts';
import { haulView, loadHaulView } from './views.ts';

export interface HaulRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * Hauls (docs/features/hauls.md): `listHauls`, `createHaul`, `getHaul`, `replaceHaul`,
 * `addHaulItems`, `removeHaulItem`. Every change settles the haul in the same transaction:
 * each item in it gets its share of the total as its cost, so profit, sales, and pricing read
 * the per-item cost from the item as they always have.
 */
export function registerHaulRoutes(app: FastifyInstance, deps: HaulRouteDependencies): void {
  contractRoute(app, deps, 'listHauls', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listHaulRows(db, tenant, {
      beforeId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const counts = await haulMemberCounts(
      db,
      tenant,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: page.map((row) => haulView(row, counts.get(row.id) ?? 0)),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'createHaul', async ({ tenant, db, body }) =>
    inTransaction(db, async (trx) => {
      const settled = await createHaulWithItems(
        trx,
        tenant,
        haulValues(body),
        body.itemIds ?? [],
        'itemIds',
        deps.now(),
      );
      return { status: 201, body: await loadHaulView(trx, tenant, settled) };
    }),
  );

  contractRoute(app, deps, 'getHaul', async ({ tenant, db, params }) => {
    const haul = await findHaul(db, tenant, params.haulId);
    if (!haul) throw notFound('Haul');
    return { status: 200, body: await loadHaulView(db, tenant, haul) };
  });

  contractRoute(app, deps, 'replaceHaul', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const haul = (await lockHauls(trx, tenant, [params.haulId])).get(params.haulId);
      if (!haul) throw notFound('Haul');
      const values = haulValues(body);
      const added = (await haulMemberCounts(trx, tenant, [haul.id])).get(haul.id) ?? 0;
      if (values.item_count < added) {
        throw validationFailed([
          {
            field: 'itemCount',
            message: `must be at least ${String(added)}, the items already in this haul`,
          },
        ]);
      }
      await updateHaul(trx, tenant, haul.id, values);
      const settled = await settleHaul(trx, tenant, haul.id);
      return { status: 200, body: await loadHaulView(trx, tenant, settled) };
    }),
  );

  contractRoute(app, deps, 'addHaulItems', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const haul = await findHaul(trx, tenant, params.haulId);
      if (!haul) throw notFound('Haul');
      const settled = await addItems(trx, tenant, haul, body.itemIds, 'itemIds', deps.now());
      return { status: 200, body: await loadHaulView(trx, tenant, settled) };
    }),
  );

  contractRoute(app, deps, 'removeHaulItem', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      const haul = (await lockHauls(trx, tenant, [params.haulId])).get(params.haulId);
      if (!haul) throw notFound('Haul');
      const item = (await lockItemsById(trx, tenant, [params.itemId])).get(params.itemId);
      if (item?.haul_id !== haul.id) throw notFound('Item in this haul');
      await leaveHaul(trx, tenant, item.id);
      await writeAudit(trx, tenant, {
        itemId: item.id,
        action: 'item.updated',
        changes: { haulId: { from: haul.id } },
      });
      const settled = await settleHaul(trx, tenant, haul.id);
      return { status: 200, body: await loadHaulView(trx, tenant, settled) };
    }),
  );
}

/** The columns a create or replace body sets: a property left out is cleared. */
function haulValues(body: {
  total: { amountCents: number; currency: 'USD' };
  itemCount: number;
  purchaseDate?: string;
  purchaseSource?: string;
}): HaulValues {
  if (body.total.amountCents < 0) {
    throw validationFailed([{ field: 'total.amountCents', message: 'must not be negative' }]);
  }
  const source = body.purchaseSource?.trim();
  return {
    total_cents: body.total.amountCents,
    currency: body.total.currency,
    item_count: body.itemCount,
    purchase_date: body.purchaseDate ?? null,
    purchase_source: source === undefined || source === '' ? null : source,
  };
}
