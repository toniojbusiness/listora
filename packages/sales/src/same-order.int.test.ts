/**
 * One sale reported twice is one order (`recordSale`, real Postgres): a sale the seller marked
 * sold by hand on a marketplace, then found there by a sale check or its sales history (which
 * names the order by the marketplace's own id, never the hand-entered one), is a duplicate, not a
 * double sale. Two hand-entered sales of one item are still a double sale. A sale from the sales
 * history is recorded only.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, type Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';

import { recordSale, type NewSale } from './sales.ts';

describe('one sale reported twice (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createMigratedDatabase('same_order', { jobQueue: true });
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  const adapters = { adapters: () => undefined };

  async function soldListing(accountId: string) {
    const item = await createInventoryItem(db, accountId, { title: 'Denim jacket' });
    const listing = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'depop',
        status: 'active',
        external_listing_id: 'shop-denim-jacket-1',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { itemId: item.id, listingId: listing.id };
  }

  const sale = (accountId: string, overrides: Partial<NewSale>): NewSale => ({
    accountId,
    marketplace: 'depop',
    externalOrderId: null,
    soldAt: new Date(),
    currency: 'USD',
    shippingChargedCents: 0,
    detectionSource: 'manual',
    inboundEventId: null,
    shipBy: null,
    lines: [],
    ...overrides,
  });

  it('is the same order when the marketplace reports a sale the seller marked sold there', async () => {
    const accountId = await insertAccount(db);
    const { itemId, listingId } = await soldListing(accountId);
    const marked = await recordSale(
      db,
      sale(accountId, { lines: [{ itemId, listingId, quantity: 1, priceCents: 4000 }] }),
      adapters,
    );
    expect(marked.type).toBe('recorded');
    for (const detectionSource of ['poll', 'history'] as const) {
      const found = await recordSale(
        db,
        sale(accountId, {
          detectionSource,
          externalOrderId: `${detectionSource}-479001`,
          lines: [
            {
              externalListingId: 'shop-denim-jacket-1',
              externalSku: null,
              quantity: 1,
              priceCents: 3800,
            },
          ],
        }),
        adapters,
      );
      expect(found).toEqual({
        type: 'duplicate',
        saleId: marked.type === 'recorded' ? marked.saleId : '',
      });
    }
    const incidents = await db
      .selectFrom('user_task')
      .select('id')
      .where('account_id', '=', accountId)
      .where('kind', '=', 'resolve_double_sale')
      .execute();
    expect(incidents).toEqual([]);
  });

  it('records a sale from the sales history only: its item sold, nothing delisted or announced', async () => {
    const accountId = await insertAccount(db);
    const { itemId } = await soldListing(accountId);
    await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: itemId,
        marketplace: 'poshmark',
        status: 'active',
        external_listing_id: 'posh-live-1',
      })
      .execute();
    const recorded = await recordSale(
      db,
      sale(accountId, {
        detectionSource: 'history',
        externalOrderId: '479001',
        lines: [
          {
            externalListingId: 'shop-denim-jacket-1',
            externalSku: null,
            quantity: 1,
            priceCents: 3800,
          },
        ],
      }),
      adapters,
    );
    expect(recorded).toMatchObject({ type: 'recorded', itemIds: [itemId], delists: [] });
    const item = await db
      .selectFrom('inventory_item')
      .select('status')
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow();
    expect(item.status).toBe('sold');
    for (const table of ['delist_run', 'marketplace_operation', 'user_task'] as const) {
      expect(
        await db.selectFrom(table).select('id').where('account_id', '=', accountId).execute(),
      ).toEqual([]);
    }
    // No job at all: no push, no delist.
    const { rows: jobs } = await sql<{ n: number }>`
      select count(*)::int as n from graphile_worker._private_jobs
      where payload->>'accountId' = ${accountId}
    `.execute(db);
    expect(jobs[0]?.n).toBe(0);
  });

  it('is still a double sale when the seller marks one item sold by hand twice', async () => {
    const accountId = await insertAccount(db);
    const { itemId, listingId } = await soldListing(accountId);
    const line = { itemId, listingId, quantity: 1, priceCents: 4000 };
    await recordSale(db, sale(accountId, { lines: [line] }), adapters);
    const again = await recordSale(db, sale(accountId, { lines: [line] }), adapters);
    expect(again.type === 'recorded' ? again.delists : []).toEqual([
      expect.objectContaining({ type: 'double_sale', itemId }),
    ]);
  });
});
