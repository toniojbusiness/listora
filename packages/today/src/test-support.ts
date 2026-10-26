/**
 * Test-only helpers for the Today integration tests (not exported from the package): a migrated
 * scratch database with the job queue, and rows for items, listings, sales, and connections. A
 * sale's delists start through the real fan-out (`startAutoDelist`), so delist cards are read
 * from the same runs, operations, and tasks the orchestrator makes.
 */
import { sql } from 'kysely';

import { startAutoDelist } from '@listora/auto-delist';
import {
  createInventoryItem,
  jsonb,
  type ConnectionMode,
  type ConnectionStatus,
  type Db,
  type ItemStatus,
  type ListingStatus,
  type Marketplace,
  type NewInventoryItem,
  type OperationKind,
} from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  createMarketplaceAdapters,
  loadDepopConfig,
  loadEbayConfig,
  type AdapterLookup,
} from '@listora/marketplaces';

/** Nothing listens here: the adapters are only asked for their capabilities. */
const UNUSED_URL = 'http://127.0.0.1:9';

export interface TodayHarness {
  db: Db;
  adapters: AdapterLookup;
  account(prefix?: string): Promise<string>;
  item(accountId: string, values?: NewInventoryItem): Promise<{ id: string; sku: string }>;
  connection(
    accountId: string,
    marketplace: Marketplace,
    options?: { mode?: ConnectionMode; status?: ConnectionStatus },
  ): Promise<string>;
  listing(
    accountId: string,
    itemId: string,
    marketplace: Marketplace,
    options?: {
      status?: ListingStatus;
      listedAt?: Date;
      connectionId?: string;
      priceCents?: number;
    },
  ): Promise<string>;
  /** An operation on a listing, created at `createdAt` (a kind without listing content). */
  operation(
    accountId: string,
    listingId: string,
    kind: Exclude<OperationKind, 'create' | 'revise' | 'relist'>,
    createdAt: Date,
  ): Promise<void>;
  /** A sale of the items (its `sale_item` rows), with its delists started. */
  sale(
    accountId: string,
    marketplace: Marketplace,
    items: readonly { itemId: string; listingId?: string | null; priceCents?: number }[],
    options?: { soldAt?: Date; shipBy?: Date | null; shippingCents?: number },
  ): Promise<{ saleId: string; saleItemIds: string[] }>;
  setItemStatus(accountId: string, itemId: string, status: ItemStatus): Promise<void>;
  /** Pending jobs of a task: key and payload. */
  jobs(task: string): Promise<{ key: string | null; payload: Record<string, unknown> }[]>;
  close(): Promise<void>;
}

export async function createTodayHarness(prefix: string): Promise<TodayHarness> {
  const database: MigratedDatabase = await createMigratedDatabase(prefix, { jobQueue: true });
  const { db } = database;
  const ebay = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: UNUSED_URL });
  const depop = loadDepopConfig({ DEPOP_ENV: 'fake', DEPOP_FAKE_URL: UNUSED_URL });
  const adapters = createMarketplaceAdapters({ fakeMarketplaceUrl: undefined, ebay, depop }).lookup;
  let sequence = 0;
  const next = () => (sequence += 1);
  return {
    db,
    adapters,
    account: async (skuPrefix = 'TD') => insertAccount(db, skuPrefix),
    async item(accountId, values = {}) {
      return createInventoryItem(db, accountId, {
        title: `Item ${String(next())}`,
        ...values,
      });
    },
    async connection(accountId, marketplace, options = {}) {
      const mode = options.mode ?? 'api';
      const row = await db
        .insertInto('marketplace_connection')
        .values({
          account_id: accountId,
          marketplace,
          mode,
          status: options.status ?? 'connected',
          ...(mode === 'api' ? { external_user_id: `seller-${String(next())}` } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async listing(accountId, itemId, marketplace, options = {}) {
      const status = options.status ?? 'active';
      const row = await db
        .insertInto('marketplace_listing')
        .values({
          account_id: accountId,
          item_id: itemId,
          marketplace,
          status,
          connection_id: options.connectionId ?? null,
          external_listing_id: status === 'draft' ? null : `ext-${String(next())}`,
          price_cents: options.priceCents ?? null,
          listed_at: options.listedAt ?? (status === 'active' ? new Date() : null),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async operation(accountId, listingId, kind, createdAt) {
      await db
        .insertInto('marketplace_operation')
        .values({
          account_id: accountId,
          listing_id: listingId,
          kind,
          idempotency_key: `op-${String(next())}`,
          desired: jsonb({}),
          status: 'succeeded',
          success_evidence: 'read_back',
          origin: 'user',
          created_at: createdAt,
        })
        .execute();
    },
    async sale(accountId, marketplace, items, options = {}) {
      return db.transaction().execute(async (trx) => {
        const sale = await trx
          .insertInto('sale')
          .values({
            account_id: accountId,
            marketplace,
            external_order_id: `order-${String(next())}`,
            sold_at: options.soldAt ?? new Date(),
            ship_by: options.shipBy ?? null,
            shipping_charged_cents: options.shippingCents ?? 0,
            detection_source: 'webhook',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const rows = await trx
          .insertInto('sale_item')
          .values(
            items.map((item) => ({
              account_id: accountId,
              sale_id: sale.id,
              marketplace,
              item_id: item.itemId,
              listing_id: item.listingId ?? null,
              sale_price_cents: item.priceCents ?? 4500,
            })),
          )
          .returning('id')
          .execute();
        await startAutoDelist(
          trx,
          {
            accountId,
            saleId: sale.id,
            marketplace,
            detectionSource: 'webhook',
            items: items.map((item) => ({
              itemId: item.itemId,
              listingId: item.listingId ?? null,
            })),
          },
          { adapters },
        );
        return { saleId: sale.id, saleItemIds: rows.map((row) => row.id) };
      });
    },
    async setItemStatus(accountId, itemId, status) {
      await db
        .updateTable('inventory_item')
        .set({ status })
        .where('account_id', '=', accountId)
        .where('id', '=', itemId)
        .execute();
    },
    async jobs(task) {
      const { rows } = await sql<{ key: string | null; payload: Record<string, unknown> }>`
        select job.key, job.payload
        from graphile_worker._private_jobs as job
        join graphile_worker._private_tasks as t on t.id = job.task_id
        where t.identifier = ${task}
        order by job.id
      `.execute(db);
      return rows;
    },
    close: () => database.close(),
  };
}
