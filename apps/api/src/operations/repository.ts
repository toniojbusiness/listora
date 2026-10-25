/**
 * Marketplace operation queries for the API. Like every repository, each function takes the
 * request's `Tenant` and filters on its account. Operations are written only by
 * `@listora/operations`.
 */
import type { DbExecutor, OperationStatus } from '@listora/db';
import { sql } from 'kysely';

import type { OperationRow } from '../listings/repository.ts';
import type { Tenant } from '../tenancy.ts';
import type { EventRow, OperationListing } from './views.ts';

export type OperationWithListing = OperationRow & OperationListing;

function operationQuery(db: DbExecutor, tenant: Tenant) {
  return db
    .selectFrom('marketplace_operation as op')
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'op.account_id')
        .onRef('listing.id', '=', 'op.listing_id'),
    )
    .selectAll('op')
    .select(['listing.item_id as item_id', 'listing.marketplace as marketplace'])
    .where('op.account_id', '=', tenant.accountId);
}

export async function findOperation(
  db: DbExecutor,
  tenant: Tenant,
  operationId: string,
): Promise<OperationWithListing | undefined> {
  return operationQuery(db, tenant).where('op.id', '=', operationId).executeTakeFirst();
}

export interface OperationListFilter {
  itemId: string | undefined;
  listingId: string | undefined;
  statuses: readonly OperationStatus[] | undefined;
  /** Return only operations older than this one (keyset pagination). */
  beforeId: string | undefined;
  limit: number;
}

/**
 * Newest first. Operation ids are UUIDv7, so id order is creation order. Returns up to
 * `limit + 1` rows so the caller can tell whether another page exists.
 */
export async function listOperationRows(
  db: DbExecutor,
  tenant: Tenant,
  filter: OperationListFilter,
): Promise<OperationWithListing[]> {
  let query = operationQuery(db, tenant);
  if (filter.itemId !== undefined) query = query.where('listing.item_id', '=', filter.itemId);
  if (filter.listingId !== undefined) query = query.where('op.listing_id', '=', filter.listingId);
  if (filter.statuses && filter.statuses.length > 0) {
    query = query.where('op.status', 'in', filter.statuses);
  }
  if (filter.beforeId !== undefined) query = query.where('op.id', '<', filter.beforeId);
  return query
    .orderBy('op.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
}

/**
 * The operation's events oldest first, each with its 1-based position in the history
 * (`sequence`), starting after the event `afterId`. Returns up to `limit + 1` rows.
 */
export async function listEventRows(
  db: DbExecutor,
  tenant: Tenant,
  operationId: string,
  page: { afterId: string | undefined; limit: number },
): Promise<EventRow[]> {
  const numbered = db
    .selectFrom('operation_event')
    .select([
      'id',
      'operation_id',
      'from_status',
      'to_status',
      'attempt',
      'error_code',
      'detail',
      'created_at',
      sql<string>`row_number() over (order by id)`.as('sequence'),
    ])
    .where('account_id', '=', tenant.accountId)
    .where('operation_id', '=', operationId)
    .as('numbered');
  let query = db.selectFrom(numbered).selectAll();
  if (page.afterId !== undefined) query = query.where('id', '>', page.afterId);
  const rows = await query
    .orderBy('id')
    .limit(page.limit + 1)
    .execute();
  return rows.map((row) => ({ ...row, sequence: Number(row.sequence) }));
}
