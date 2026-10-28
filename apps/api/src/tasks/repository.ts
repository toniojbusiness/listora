/**
 * User task queries for the API. Like every repository, each function takes the request's
 * `Tenant` and filters on its account. Tasks are created by the operation engine (an assisted
 * step) and finished here, through the engine's own commands when they belong to an operation.
 */
import { OFFER_MARKETPLACES, readsOffers } from '@listora/automation';
import type {
  DbExecutor,
  DbTransaction,
  JsonValue,
  Marketplace,
  OperationKind,
  UserTaskKind,
  UserTaskStatus,
  UserTaskUrgency,
} from '@listora/db';
import { sql } from 'kysely';

import type { Tenant } from '../tenancy.ts';

/** A task with what its view shows: the listing's marketplace, the operation, the item. */
export interface TaskRow {
  id: string;
  kind: UserTaskKind;
  status: UserTaskStatus;
  urgency: UserTaskUrgency;
  item_id: string | null;
  listing_id: string | null;
  operation_id: string | null;
  delist_run_id: string | null;
  /** The sale a task is about (the later sale of a double sale). */
  sale_id: string | null;
  deep_link: string | null;
  payload: JsonValue;
  completed_at: Date | null;
  created_at: Date;
  marketplace: Marketplace | null;
  operation_kind: OperationKind | null;
  item_sku: string | null;
  item_title: string | null;
  /** For a delist after a sale, the marketplace the item sold on. */
  sold_on: Marketplace | null;
  /** The offer an `answer_offer` task is about. */
  offer_id: string | null;
}

/** Urgent tasks first, then high, then normal. */
const URGENCY_RANK = sql<number>`case task.urgency when 'urgent' then 0 when 'high' then 1 else 2 end`;

function taskQuery(db: DbExecutor, tenant: Tenant) {
  return db
    .selectFrom('user_task as task')
    .leftJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'task.account_id')
        .onRef('listing.id', '=', 'task.listing_id'),
    )
    .leftJoin('marketplace_operation as op', (join) =>
      join.onRef('op.account_id', '=', 'task.account_id').onRef('op.id', '=', 'task.operation_id'),
    )
    .leftJoin('inventory_item as item', (join) =>
      join.onRef('item.account_id', '=', 'task.account_id').onRef('item.id', '=', 'task.item_id'),
    )
    .leftJoin('delist_run as run', (join) =>
      join
        .onRef('run.account_id', '=', 'task.account_id')
        .onRef('run.id', '=', 'task.delist_run_id'),
    )
    .leftJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'run.account_id').onRef('sale.id', '=', 'run.sale_id'),
    )
    .select([
      'task.id as id',
      'task.kind as kind',
      'task.status as status',
      'task.urgency as urgency',
      'task.item_id as item_id',
      'task.listing_id as listing_id',
      'task.operation_id as operation_id',
      'task.delist_run_id as delist_run_id',
      'task.sale_id as sale_id',
      'task.deep_link as deep_link',
      'task.payload as payload',
      'task.completed_at as completed_at',
      'task.created_at as created_at',
      'listing.marketplace as marketplace',
      'op.kind as operation_kind',
      'item.sku as item_sku',
      'item.title as item_title',
      'sale.marketplace as sold_on',
      'task.offer_id as offer_id',
    ])
    .where('task.account_id', '=', tenant.accountId);
}

export async function findTask(
  db: DbExecutor,
  tenant: Tenant,
  taskId: string,
): Promise<TaskRow | undefined> {
  return taskQuery(db, tenant).where('task.id', '=', taskId).executeTakeFirst();
}

export interface TaskListFilter {
  statuses: readonly UserTaskStatus[] | undefined;
  itemId: string | undefined;
  /** Continue after this task, in list order (keyset pagination). */
  afterId: string | undefined;
  limit: number;
}

/**
 * Urgent first, then oldest first (task ids are UUIDv7, so id order is creation order).
 * Returns up to `limit + 1` rows so the caller can tell whether another page exists.
 */
export async function listTaskRows(
  db: DbExecutor,
  tenant: Tenant,
  filter: TaskListFilter,
): Promise<TaskRow[]> {
  let query = taskQuery(db, tenant);
  // An offer on a marketplace whose offers Listora doesn't show (verified-features.md).
  const hidden = OFFER_MARKETPLACES.filter((marketplace) => !readsOffers(marketplace));
  if (hidden.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb('task.offer_id', 'is', null),
        eb.not(
          eb.exists(
            eb
              .selectFrom('marketplace_offer as offer')
              .select('offer.id')
              .whereRef('offer.account_id', '=', 'task.account_id')
              .whereRef('offer.id', '=', 'task.offer_id')
              .where('offer.marketplace', 'in', hidden),
          ),
        ),
      ]),
    );
  }
  if (filter.statuses && filter.statuses.length > 0) {
    query = query.where('task.status', 'in', filter.statuses);
  }
  if (filter.itemId !== undefined) query = query.where('task.item_id', '=', filter.itemId);
  if (filter.afterId !== undefined) {
    const after = sql<number>`(select case urgency when 'urgent' then 0 when 'high' then 1 else 2 end
      from user_task where account_id = ${tenant.accountId} and id = ${filter.afterId})`;
    query = query.where(sql<boolean>`(${URGENCY_RANK}, task.id) > (${after}, ${filter.afterId})`);
  }
  return query
    .orderBy(URGENCY_RANK)
    .orderBy('task.id')
    .limit(filter.limit + 1)
    .execute();
}

/** Locks the task row for a change; undefined when the account has no such task. */
export async function lockTask(
  trx: DbTransaction,
  tenant: Tenant,
  taskId: string,
): Promise<{ id: string; status: UserTaskStatus } | undefined> {
  return trx
    .selectFrom('user_task')
    .select(['id', 'status'])
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', taskId)
    .forUpdate()
    .executeTakeFirst();
}

/** Finishes a task that no operation waits on; `saleId` is the sale a sale email's task recorded. */
export async function settleTask(
  trx: DbTransaction,
  tenant: Tenant,
  taskId: string,
  status: 'done' | 'dismissed',
  saleId?: string,
): Promise<void> {
  await trx
    .updateTable('user_task')
    .set({
      status,
      completed_at: sql<Date>`now()`,
      ...(saleId === undefined ? {} : { sale_id: saleId }),
    })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', taskId)
    .where('status', '=', 'open')
    .execute();
}

/**
 * The open task that asks the user to list the item on the marketplace, if any: the one a
 * listing link shared from the marketplace finishes.
 */
export async function openListTaskFor(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  marketplace: Marketplace,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('user_task as task')
    .innerJoin('marketplace_listing as listing', (join) =>
      join
        .onRef('listing.account_id', '=', 'task.account_id')
        .onRef('listing.id', '=', 'task.listing_id'),
    )
    .select('task.id')
    .where('task.account_id', '=', tenant.accountId)
    .where('task.item_id', '=', itemId)
    .where('task.kind', '=', 'list_manually')
    .where('task.status', '=', 'open')
    .where('listing.marketplace', '=', marketplace)
    .orderBy('task.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.id;
}

/** The ready photos the task's copy-assist names, by id. */
export async function photoRowsById(db: DbExecutor, tenant: Tenant, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .selectFrom('photo')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', [...ids])
    .execute();
}

/** Each item's cover photo (position 0). */
export async function coverPhotoRows(db: DbExecutor, tenant: Tenant, itemIds: readonly string[]) {
  if (itemIds.length === 0) return [];
  return db
    .selectFrom('photo')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('item_id', 'in', [...itemIds])
    .where('position', '=', 0)
    .execute();
}

/** The items a sale email's review task may be about, for its candidates. */
export async function itemSummaryRows(db: DbExecutor, tenant: Tenant, itemIds: readonly string[]) {
  if (itemIds.length === 0) return [];
  return db
    .selectFrom('inventory_item')
    .select(['id', 'sku', 'title'])
    .where('account_id', '=', tenant.accountId)
    .where('id', 'in', [...itemIds])
    .execute();
}
