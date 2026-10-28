import type { FieldError } from '@listora/api-contract';
import { inTransaction, type DbTransaction } from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { notFound, validationFailed } from '../errors.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import type { Tenant } from '../tenancy.ts';
import {
  findHaul,
  haulMemberCounts,
  insertHaul,
  joinHaul,
  leaveHaul,
  listHaulRows,
  lockHauls,
  lockItemsById,
  settleHaul,
  updateHaul,
  type HaulRow,
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
      const itemIds = body.itemIds ?? [];
      const values = haulValues(body);
      // A haul of more items than its count has at least that many.
      values.item_count = Math.max(values.item_count, itemIds.length);
      const haul = await insertHaul(trx, tenant, values);
      const settled = await addItems(trx, tenant, haul, itemIds, 'itemIds', deps.now());
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

/**
 * Puts the items in the haul, in order, then settles it and every haul they left. The hauls'
 * locks are taken first (in id order), then the items', the order every haul change uses. An id
 * that is not an item of this account is a field error naming its place in `field`.
 */
async function addItems(
  trx: DbTransaction,
  tenant: Tenant,
  haul: HaulRow,
  itemIds: readonly string[],
  field: string,
  now: Date,
): Promise<HaulRow> {
  // Where the items are now, to lock the hauls they leave with this one.
  const current =
    itemIds.length === 0
      ? []
      : await trx
          .selectFrom('inventory_item')
          .select('haul_id')
          .where('account_id', '=', tenant.accountId)
          .where('id', 'in', itemIds)
          .execute();
  const locked = await lockHauls(trx, tenant, [
    haul.id,
    ...current.flatMap((row) => (row.haul_id === null ? [] : [row.haul_id])),
  ]);
  if (!locked.has(haul.id)) throw notFound('Haul');
  const items = await lockItemsById(trx, tenant, itemIds);
  const unknown: FieldError[] = itemIds.flatMap((id, index) =>
    items.has(id) ? [] : [{ field: `${field}[${String(index)}]`, message: 'is not an item' }],
  );
  if (unknown.length > 0) throw validationFailed(unknown);
  // An item that moved to another haul between the read and its lock: lock that one too.
  const unlocked = [...items.values()].flatMap((item) =>
    item.haul_id === null || locked.has(item.haul_id) ? [] : [item.haul_id],
  );
  for (const [id, row] of await lockHauls(trx, tenant, unlocked)) locked.set(id, row);

  const ordered = itemIds.map((id) => items.get(id)).filter((item) => item !== undefined);
  const moved = await joinHaul(trx, tenant, haul.id, ordered, now);
  const settled = await settleHaul(trx, tenant, haul.id, moved);
  // The hauls the items left: their remaining items get their new shares.
  const previous = new Set([...moved.values()].filter((id) => id !== null));
  for (const previousId of [...previous].sort()) await settleHaul(trx, tenant, previousId);
  return settled;
}
