/**
 * Test-only helpers for the orchestrator's integration tests (not exported from the package):
 * a migrated scratch database with the job queue, the adapters the worker runs with (their
 * capabilities decide each delist; nothing here calls a marketplace), and rows for items,
 * listings, connections, and sales.
 */
import { sql } from 'kysely';

import {
  createInventoryItem,
  type ConnectionMode,
  type Db,
  type ListingStatus,
  type Marketplace,
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

export interface DelistHarness {
  db: Db;
  database: MigratedDatabase;
  accountId: string;
  adapters: AdapterLookup;
  item(title?: string): Promise<{ id: string; sku: string }>;
  connection(marketplace: Marketplace, mode?: ConnectionMode): Promise<string>;
  listing(
    itemId: string,
    marketplace: Marketplace,
    options?: { status?: ListingStatus; connectionId?: string; externalListingId?: string },
  ): Promise<string>;
  /** A sale of the items on `marketplace`, with its `sale_item` rows (no fan-out). */
  sale(
    marketplace: Marketplace,
    items: readonly { itemId: string; listingId: string | null }[],
  ): Promise<string>;
  /** Pending jobs of a task: key, payload, queue, and priority. */
  jobs(task: string): Promise<JobRow[]>;
  close(): Promise<void>;
}

export interface JobRow {
  key: string | null;
  payload: Record<string, unknown>;
  queue_name: string | null;
  priority: number;
}

export async function createDelistHarness(prefix: string): Promise<DelistHarness> {
  const database = await createMigratedDatabase(prefix, { jobQueue: true, max: 10 });
  const { db } = database;
  const accountId = await insertAccount(db, 'ADL');
  const ebay = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: UNUSED_URL });
  const depop = loadDepopConfig({ DEPOP_ENV: 'fake', DEPOP_FAKE_URL: UNUSED_URL });
  const adapters = createMarketplaceAdapters({ fakeMarketplaceUrl: undefined, ebay, depop }).lookup;
  let sequence = 0;
  return {
    db,
    database,
    accountId,
    adapters,
    async item(title) {
      sequence += 1;
      return createInventoryItem(db, accountId, {
        title: title ?? `Delist item ${String(sequence)}`,
        status: 'listed',
      });
    },
    async connection(marketplace, mode = 'api') {
      sequence += 1;
      const row = await db
        .insertInto('marketplace_connection')
        .values({
          account_id: accountId,
          marketplace,
          mode,
          ...(mode === 'api' ? { external_user_id: `seller-${String(sequence)}` } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async listing(itemId, marketplace, options = {}) {
      sequence += 1;
      const status = options.status ?? 'active';
      const row = await db
        .insertInto('marketplace_listing')
        .values({
          account_id: accountId,
          item_id: itemId,
          marketplace,
          status,
          connection_id: options.connectionId ?? null,
          external_listing_id:
            options.externalListingId ?? (status === 'draft' ? null : `ext-${String(sequence)}`),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async sale(marketplace, items) {
      sequence += 1;
      const sale = await db
        .insertInto('sale')
        .values({
          account_id: accountId,
          marketplace,
          external_order_id: `order-${String(sequence)}`,
          sold_at: new Date(),
          detection_source: 'webhook',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('sale_item')
        .values(
          items.map((item) => ({
            account_id: accountId,
            sale_id: sale.id,
            marketplace,
            item_id: item.itemId,
            listing_id: item.listingId,
            sale_price_cents: 4500,
          })),
        )
        .execute();
      return sale.id;
    },
    async jobs(task) {
      const { rows } = await sql<JobRow>`
        select job.key, job.payload, queue.queue_name, job.priority
        from graphile_worker._private_jobs as job
        join graphile_worker._private_tasks as t on t.id = job.task_id
        left join graphile_worker._private_job_queues as queue on queue.id = job.job_queue_id
        where t.identifier = ${task}
        order by job.id
      `.execute(db);
      return rows;
    },
    close: () => database.close(),
  };
}
