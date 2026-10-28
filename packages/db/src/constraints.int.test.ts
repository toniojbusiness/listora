import { sql, type Updateable } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './database.ts';
import { createInventoryItem } from './items.ts';
import { jsonb } from './json.ts';
import type { AiAnalysisTable, MarketplaceConnectionTable, PhotoTable } from './schema.ts';
import {
  createMigratedDatabase,
  expectPgError,
  insertAccount,
  PG_ERROR,
  type MigratedDatabase,
} from './test-support.ts';

const HASH = 'a'.repeat(64);

/** The `photo.derivatives` of a processed photo (the shape @listora/photos writes). */
const DERIVATIVES = Object.fromEntries(
  ['original', 'ai', 'thumbnail', 'listing'].map((kind) => [
    kind,
    { key: `photos/${kind}.jpg`, width: 10, height: 10, byteSize: 100, sha256: HASH },
  ]),
);

/** An account with one item, an eBay API connection, and a live listing. */
async function seedAccount(db: Db, prefix: string) {
  const accountId = await insertAccount(db, prefix);
  const item = await createInventoryItem(db, accountId, { title: 'Levi 501' });
  const connection = await db
    .insertInto('marketplace_connection')
    .values({
      account_id: accountId,
      marketplace: 'ebay',
      mode: 'api',
      external_user_id: `ebay-${prefix}`,
      token_ciphertext: Buffer.from('ciphertext'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const listing = await db
    .insertInto('marketplace_listing')
    .values({
      account_id: accountId,
      item_id: item.id,
      marketplace: 'ebay',
      connection_id: connection.id,
      price_cents: 4_500,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { accountId, itemId: item.id, connectionId: connection.id, listingId: listing.id };
}

type Seed = Awaited<ReturnType<typeof seedAccount>>;

/** A second item of the seed account with its own live eBay listing. */
async function addListedItem(db: Db, seed: Seed) {
  const item = await createInventoryItem(db, seed.accountId);
  const listing = await db
    .insertInto('marketplace_listing')
    .values({
      account_id: seed.accountId,
      item_id: item.id,
      marketplace: 'ebay',
      connection_id: seed.connectionId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { itemId: item.id, listingId: listing.id };
}

async function insertSale(
  db: Db,
  accountId: string,
  externalOrderId: string,
  marketplace: 'ebay' | 'depop' = 'ebay',
) {
  const sale = await db
    .insertInto('sale')
    .values({
      account_id: accountId,
      marketplace,
      external_order_id: externalOrderId,
      sold_at: new Date(),
      detection_source: 'webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return sale.id;
}

function insertSaleItem(
  db: Db,
  accountId: string,
  saleId: string,
  item: { itemId: string; listingId: string | null },
  marketplace: 'ebay' | 'depop' = 'ebay',
) {
  return db
    .insertInto('sale_item')
    .values({
      account_id: accountId,
      sale_id: saleId,
      marketplace,
      item_id: item.itemId,
      listing_id: item.listingId,
      sale_price_cents: 4_500,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

function insertOperation(
  db: Db,
  seed: Seed,
  overrides: { idempotency_key?: string; account_id?: string } = {},
) {
  return db
    .insertInto('marketplace_operation')
    .values({
      account_id: seed.accountId,
      listing_id: seed.listingId,
      kind: 'create',
      idempotency_key: 'create-1',
      desired: jsonb({ price_cents: 4_500 }),
      content: jsonb({ variant: { title: 'Jacket' } }),
      origin: 'user',
      ...overrides,
    })
    .returning(['id', 'status'])
    .executeTakeFirstOrThrow();
}

describe('schema constraints (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    database = await createMigratedDatabase('constraints');
    db = database.db;
    a = await seedAccount(db, 'AA');
    b = await seedAccount(db, 'BB');
  });

  afterAll(async () => {
    await database.close();
  });

  describe('unique keys', () => {
    it('keeps SKUs unique per account but lets accounts share a SKU', async () => {
      const prefixA = await insertAccount(db, 'SAM');
      const prefixB = await insertAccount(db, 'SAM');
      await db
        .insertInto('inventory_item')
        .values({ account_id: prefixA, sku: 'SAM-000500' })
        .execute();
      await db
        .insertInto('inventory_item')
        .values({ account_id: prefixB, sku: 'SAM-000500' })
        .execute();
      await expectPgError(
        db
          .insertInto('inventory_item')
          .values({ account_id: prefixA, sku: 'SAM-000500' })
          .execute(),
        PG_ERROR.uniqueViolation,
        'inventory_item_account_id_sku_key',
      );
    });

    it('rejects a SKU that does not follow the PREFIX-000000 format', async () => {
      await expectPgError(
        db
          .insertInto('inventory_item')
          .values({ account_id: a.accountId, sku: 'AA-184' })
          .execute(),
        PG_ERROR.checkViolation,
        'inventory_item_sku_check',
      );
    });

    it('records an operation idempotency key once per account', async () => {
      await insertOperation(db, a, { idempotency_key: 'idem-shared' });
      await insertOperation(db, b, { idempotency_key: 'idem-shared' });
      await expectPgError(
        insertOperation(db, a, { idempotency_key: 'idem-shared' }),
        PG_ERROR.uniqueViolation,
        'marketplace_operation_account_id_idempotency_key_key',
      );
    });

    it('deduplicates inbound events per account, source, and marketplace', async () => {
      const event = (
        accountId: string,
        source: 'ebay_webhook' | 'poll',
        marketplace: 'ebay' | 'mercari' | 'depop',
      ) =>
        db
          .insertInto('inbound_event')
          .values({
            account_id: accountId,
            source,
            marketplace,
            provider_event_id: 'evt-1',
            signature_ok: source === 'poll' ? null : true,
            payload: jsonb({ orderId: 'o-1' }),
          })
          .execute();
      await event(a.accountId, 'ebay_webhook', 'ebay');
      await event(a.accountId, 'poll', 'ebay');
      await event(a.accountId, 'poll', 'mercari');
      await event(a.accountId, 'poll', 'depop');
      await event(b.accountId, 'poll', 'mercari');
      await expectPgError(
        event(a.accountId, 'poll', 'mercari'),
        PG_ERROR.uniqueViolation,
        'inbound_event_provider_event_key',
      );
      await expectPgError(
        event(b.accountId, 'poll', 'mercari'),
        PG_ERROR.uniqueViolation,
        'inbound_event_provider_event_key',
      );
    });

    it('requires a signature verdict for webhook and email events', async () => {
      await expectPgError(
        db
          .insertInto('inbound_event')
          .values({
            account_id: a.accountId,
            source: 'depop_webhook',
            marketplace: 'depop',
            provider_event_id: 'evt-unsigned',
            payload: jsonb({}),
          })
          .execute(),
        PG_ERROR.checkViolation,
        'inbound_event_signed_source_has_signature',
      );
    });

    it('records a marketplace order once per marketplace', async () => {
      await insertSale(db, a.accountId, 'order-77', 'ebay');
      await insertSale(db, a.accountId, 'order-77', 'depop');
      await insertSale(db, b.accountId, 'order-77', 'ebay');
      await expectPgError(
        insertSale(db, a.accountId, 'order-77', 'ebay'),
        PG_ERROR.uniqueViolation,
        'sale_account_id_marketplace_external_order_id_key',
      );
    });

    it("analyzes an item's photo set once per tier, premium only as an escalation", async () => {
      const analysis = (values: {
        itemId?: string;
        tier?: 'standard' | 'premium';
        escalatedFrom?: string;
      }) =>
        db
          .insertInto('ai_analysis')
          .values({
            account_id: a.accountId,
            item_id: values.itemId ?? a.itemId,
            photo_set_hash: HASH,
            tier: values.tier ?? 'standard',
            model: 'claude-haiku-5-5',
            escalated_from_analysis_id: values.escalatedFrom ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      const standard = await analysis({});
      await expectPgError(
        analysis({ tier: 'premium' }),
        PG_ERROR.checkViolation,
        'ai_analysis_premium_iff_escalated',
      );
      await expectPgError(
        analysis({ escalatedFrom: standard.id }),
        PG_ERROR.checkViolation,
        'ai_analysis_premium_iff_escalated',
      );
      await analysis({ tier: 'premium', escalatedFrom: standard.id });
      await expectPgError(
        analysis({}),
        PG_ERROR.uniqueViolation,
        'ai_analysis_account_id_item_id_photo_set_hash_tier_key',
      );
      // Another item with the same photos is analyzed on its own.
      const twin = await createInventoryItem(db, a.accountId);
      const twinAnalysis = await analysis({ itemId: twin.id });
      // A premium analysis escalates an analysis of its own item.
      const third = await createInventoryItem(db, a.accountId);
      await expectPgError(
        analysis({ itemId: third.id, tier: 'premium', escalatedFrom: twinAnalysis.id }),
        PG_ERROR.foreignKeyViolation,
        'ai_analysis_account_id_item_id_escalated_from_analysis_id_fkey',
      );
    });

    it('records why and when an analysis finished', async () => {
      const item = await createInventoryItem(db, a.accountId);
      const { id } = await db
        .insertInto('ai_analysis')
        .values({
          account_id: a.accountId,
          item_id: item.id,
          photo_set_hash: HASH,
          tier: 'standard',
          model: 'claude-haiku-5-5',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const update = (values: Updateable<AiAnalysisTable>) =>
        db.updateTable('ai_analysis').set(values).where('id', '=', id).execute();
      const failed = {
        status: 'failed',
        error_code: 'invalid_output',
        error_message: 'The answer did not match the schema.',
        error_retryable: true,
        completed_at: new Date(),
      } as const;
      await expectPgError(
        update({ ...failed, error_retryable: null }),
        PG_ERROR.checkViolation,
        'ai_analysis_failed_has_retryable',
      );
      await expectPgError(
        update({ ...failed, completed_at: null }),
        PG_ERROR.checkViolation,
        'ai_analysis_completed_at_iff_finished',
      );
      await expectPgError(
        update({ ...failed, error_code: 'Not A Code' }),
        PG_ERROR.checkViolation,
        'ai_analysis_error_code_format',
      );
      await update(failed);
      await expectPgError(
        update({ status: 'pending', error_code: null, completed_at: null }),
        PG_ERROR.checkViolation,
        'ai_analysis_failed_has_retryable',
      );
      await update({
        status: 'pending',
        error_code: null,
        error_message: null,
        error_retryable: null,
        completed_at: null,
      });
    });

    it('allows one owner per account', async () => {
      const account = await insertAccount(db, 'OWN');
      const user = async (subject: string) =>
        (
          await db
            .insertInto('app_user')
            .values({ auth_provider: 'dev', auth_subject: subject })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const first = await user('owner-1');
      const second = await user('owner-2');
      await db
        .insertInto('membership')
        .values({ account_id: account, user_id: first, role: 'owner' })
        .execute();
      await expectPgError(
        db
          .insertInto('membership')
          .values({ account_id: account, user_id: second, role: 'owner' })
          .execute(),
        PG_ERROR.uniqueViolation,
        'membership_one_owner_idx',
      );
      await db
        .insertInto('membership')
        .values({ account_id: account, user_id: second, role: 'admin' })
        .execute();
    });

    it('allows one live listing per item and marketplace, keeping ended ones as history', async () => {
      await expectPgError(
        db
          .insertInto('marketplace_listing')
          .values({ account_id: a.accountId, item_id: a.itemId, marketplace: 'ebay' })
          .execute(),
        PG_ERROR.uniqueViolation,
        'marketplace_listing_one_live_idx',
      );

      const seed = await seedAccount(db, 'REL');
      await db
        .updateTable('marketplace_listing')
        .set({ status: 'ended', ended_at: new Date() })
        .where('id', '=', seed.listingId)
        .execute();
      await db
        .insertInto('marketplace_listing')
        .values({ account_id: seed.accountId, item_id: seed.itemId, marketplace: 'ebay' })
        .execute();
    });

    it('links a short-link-only listing URL once per account and marketplace', async () => {
      const url = 'https://posh.mk/aBc12XyZ';
      const first = await createInventoryItem(db, a.accountId);
      const second = await createInventoryItem(db, a.accountId);
      const link = (accountId: string, itemId: string, externalUrl: string) =>
        db
          .insertInto('marketplace_listing')
          .values({
            account_id: accountId,
            item_id: itemId,
            marketplace: 'poshmark',
            status: 'active',
            external_url: externalUrl,
            user_confirmed_at: new Date(),
          })
          .execute();
      await link(a.accountId, first.id, url);
      await expectPgError(
        link(a.accountId, second.id, url),
        PG_ERROR.uniqueViolation,
        'marketplace_listing_url_only_idx',
      );
      // Short link codes are case-sensitive, and another account may link the same URL.
      await link(a.accountId, second.id, 'https://posh.mk/ABC12XYZ');
      await link(b.accountId, b.itemId, url);
      // A URL with a listing id is identified by the id, so its URL is not a key.
      const third = await createInventoryItem(db, a.accountId);
      const fourth = await createInventoryItem(db, a.accountId);
      for (const [itemId, id] of [
        [third.id, 'm12345678901'],
        [fourth.id, 'm12345678902'],
      ] as const) {
        await db
          .insertInto('marketplace_listing')
          .values({
            account_id: a.accountId,
            item_id: itemId,
            marketplace: 'mercari',
            external_listing_id: id,
            external_url: 'https://www.mercari.com/us/item/shared/',
          })
          .execute();
      }
    });
  });

  describe('bundle sales', () => {
    it('records every item of a multi-item order, each item once', async () => {
      const seed = await seedAccount(db, 'BUN');
      const second = await addListedItem(db, seed);
      const saleId = await insertSale(db, seed.accountId, 'bundle-1');
      await insertSaleItem(db, seed.accountId, saleId, seed);
      await insertSaleItem(db, seed.accountId, saleId, second);

      const items = await db
        .selectFrom('sale_item')
        .select('item_id')
        .where('sale_id', '=', saleId)
        .orderBy('item_id')
        .execute();
      expect(items.map((row) => row.item_id)).toEqual([seed.itemId, second.itemId].sort());

      await expectPgError(
        insertSaleItem(db, seed.accountId, saleId, second),
        PG_ERROR.uniqueViolation,
        'sale_item_account_id_sale_id_item_id_key',
      );
    });

    it("accepts only the item's own listing on the sale's marketplace", async () => {
      const seed = await seedAccount(db, 'MKT');
      const second = await addListedItem(db, seed);
      const depopSale = await insertSale(db, seed.accountId, 'depop-1', 'depop');
      await expectPgError(
        insertSaleItem(db, seed.accountId, depopSale, seed, 'ebay'),
        PG_ERROR.foreignKeyViolation,
        'sale_item_account_id_sale_id_marketplace_fkey',
      );
      await expectPgError(
        insertSaleItem(db, seed.accountId, depopSale, seed, 'depop'),
        PG_ERROR.foreignKeyViolation,
        'sale_item_account_id_listing_id_item_id_marketplace_fkey',
      );
      await insertSaleItem(db, seed.accountId, depopSale, { ...seed, listingId: null }, 'depop');

      const ebaySale = await insertSale(db, seed.accountId, 'ebay-1');
      await expectPgError(
        insertSaleItem(db, seed.accountId, ebaySale, { ...seed, listingId: second.listingId }),
        PG_ERROR.foreignKeyViolation,
        'sale_item_account_id_listing_id_item_id_marketplace_fkey',
      );
    });

    it('ties fee lines and delist runs to items of the same sale', async () => {
      const seed = await seedAccount(db, 'TIE');
      const second = await addListedItem(db, seed);
      const saleId = await insertSale(db, seed.accountId, 'tie-1');
      const sold = await insertSaleItem(db, seed.accountId, saleId, seed);
      const otherSaleId = await insertSale(db, seed.accountId, 'tie-2');
      const otherSold = await insertSaleItem(db, seed.accountId, otherSaleId, second);

      const fee = (saleItemId: string | null) =>
        db
          .insertInto('fee_line')
          .values({
            account_id: seed.accountId,
            sale_id: saleId,
            sale_item_id: saleItemId,
            kind: 'marketplace',
            amount_cents: 600,
            source: 'actual',
          })
          .execute();
      await fee(sold.id);
      await fee(null);
      await expectPgError(
        fee(otherSold.id),
        PG_ERROR.foreignKeyViolation,
        'fee_line_account_id_sale_id_sale_item_id_fkey',
      );

      const run = (itemId: string) =>
        db
          .insertInto('delist_run')
          .values({ account_id: seed.accountId, sale_id: saleId, item_id: itemId })
          .execute();
      await run(seed.itemId);
      await expectPgError(
        run(second.itemId),
        PG_ERROR.foreignKeyViolation,
        'delist_run_account_id_sale_id_item_id_fkey',
      );
      await expectPgError(
        run(seed.itemId),
        PG_ERROR.uniqueViolation,
        'delist_run_account_id_sale_id_item_id_key',
      );
    });
  });

  describe('status values', () => {
    it.each([
      ['inventory_item', 'status', 'published'],
      ['marketplace_listing', 'status', 'live'],
      ['marketplace_operation', 'status', 'done'],
    ] as const)('rejects %s.%s = %s', async (table, column, value) => {
      await expectPgError(
        sql`update ${sql.table(table)} set ${sql.ref(column)} = ${value}`.execute(db),
        PG_ERROR.checkViolation,
        `${table}_${column}_check`,
      );
    });

    it('rejects an unknown marketplace through the marketplace_id domain', async () => {
      await expectPgError(
        sql`insert into marketplace_connection (account_id, marketplace, mode)
            values (${a.accountId}, 'etsy', 'assisted')`.execute(db),
        PG_ERROR.checkViolation,
        'marketplace_id_known',
      );
    });
  });

  describe('money', () => {
    it('stores integer cents with a currency and reads them back as numbers', async () => {
      const item = await createInventoryItem(db, a.accountId, {
        list_price_cents: 12_345,
        floor_price_cents: 9_000,
        cost_cents: 400,
      });
      expect(item).toMatchObject({
        currency: 'USD',
        list_price_cents: 12_345,
        floor_price_cents: 9_000,
        cost_cents: 400,
      });
    });

    it('rejects negative amounts, fractional cents, and unknown currencies', async () => {
      await expectPgError(
        createInventoryItem(db, a.accountId, { list_price_cents: -1 }),
        PG_ERROR.checkViolation,
        'inventory_item_list_price_cents_check',
      );
      // Bound parameters reach bigint columns as text, so fractional cents never round.
      await expectPgError(
        createInventoryItem(db, a.accountId, { list_price_cents: 10.5 }),
        PG_ERROR.invalidTextRepresentation,
      );
      await expectPgError(
        sql`update inventory_item set currency = 'usd' where id = ${a.itemId}`.execute(db),
        PG_ERROR.checkViolation,
        'currency_code_known',
      );
    });

    it('keeps the floor price at or below the list price', async () => {
      await expectPgError(
        createInventoryItem(db, a.accountId, { list_price_cents: 1_000, floor_price_cents: 1_001 }),
        PG_ERROR.checkViolation,
        'inventory_item_floor_within_list_price',
      );
    });
  });

  describe('optimistic locking and timestamps', () => {
    it('bumps version on every update so stale writers match no row', async () => {
      const item = await createInventoryItem(db, a.accountId, { title: 'v1' });
      expect(item.version).toBe(1);

      const updated = await db
        .updateTable('inventory_item')
        .set({ title: 'v2' })
        .where('id', '=', item.id)
        .where('version', '=', 1)
        .returning(['version', 'updated_at'])
        .executeTakeFirstOrThrow();
      expect(updated.version).toBe(2);

      const stale = await db
        .updateTable('inventory_item')
        .set({ title: 'lost update' })
        .where('id', '=', item.id)
        .where('version', '=', 1)
        .executeTakeFirst();
      expect(stale.numUpdatedRows).toBe(0n);

      // A caller cannot reset the version: the trigger always increments it.
      await sql`update inventory_item set version = 1 where id = ${item.id}`.execute(db);
      const current = await db
        .selectFrom('inventory_item')
        .select(['version', 'title'])
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow();
      expect(current).toEqual({ version: 3, title: 'v2' });
    });

    it('sets updated_at on update', async () => {
      const item = await createInventoryItem(db, a.accountId);
      // now() is the transaction start time, so the update must run in a later transaction.
      await sql`select pg_sleep(0.01)`.execute(db);
      const updated = await db
        .updateTable('inventory_item')
        .set({ title: 'touched' })
        .where('id', '=', item.id)
        .returning(['created_at', 'updated_at'])
        .executeTakeFirstOrThrow();
      expect(updated.created_at).toEqual(item.created_at);
      expect(updated.updated_at.getTime()).toBeGreaterThan(item.updated_at.getTime());
    });

    it('reads date columns as calendar dates, independent of the timezone', async () => {
      const item = await createInventoryItem(db, a.accountId, { purchase_date: '2026-01-31' });
      expect(item.purchase_date).toBe('2026-01-31');
    });
  });

  describe('tenant isolation', () => {
    it("rejects a row that points at another account's data", async () => {
      await expectPgError(
        db
          .insertInto('photo')
          .values({
            account_id: b.accountId,
            item_id: a.itemId,
            position: 0,
            role: 'front',
            storage_key: 'b/cross-tenant.jpg',
          })
          .execute(),
        PG_ERROR.foreignKeyViolation,
        'photo_account_id_item_id_fkey',
      );
      await expectPgError(
        insertOperation(db, { ...a, accountId: b.accountId }, { idempotency_key: 'cross-tenant' }),
        PG_ERROR.foreignKeyViolation,
        'marketplace_operation_account_id_listing_id_fkey',
      );
      await expectPgError(
        db
          .insertInto('marketplace_listing')
          .values({
            account_id: b.accountId,
            item_id: b.itemId,
            marketplace: 'depop',
            connection_id: a.connectionId,
          })
          .execute(),
        PG_ERROR.foreignKeyViolation,
      );
    });

    it('rejects a listing on a connection for a different marketplace', async () => {
      const item = await createInventoryItem(db, a.accountId);
      await expectPgError(
        db
          .insertInto('marketplace_listing')
          .values({
            account_id: a.accountId,
            item_id: item.id,
            marketplace: 'depop',
            connection_id: a.connectionId,
          })
          .execute(),
        PG_ERROR.foreignKeyViolation,
        'marketplace_listing_account_id_connection_id_marketplace_fkey',
      );
    });

    it('accepts only an analysis of the same item as the accepted analysis', async () => {
      const other = await createInventoryItem(db, a.accountId);
      const analysis = await db
        .insertInto('ai_analysis')
        .values({
          account_id: a.accountId,
          item_id: other.id,
          photo_set_hash: 'b'.repeat(64),
          tier: 'standard',
          model: 'claude-haiku-5-5',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectPgError(
        db
          .updateTable('inventory_item')
          .set({ accepted_analysis_id: analysis.id })
          .where('id', '=', a.itemId)
          .execute(),
        PG_ERROR.foreignKeyViolation,
      );
      await db
        .updateTable('inventory_item')
        .set({ accepted_analysis_id: analysis.id })
        .where('id', '=', other.id)
        .execute();
    });
  });

  describe('never false success', () => {
    it('requires read-back or user confirmation evidence for succeeded', async () => {
      const operation = await insertOperation(db, a, { idempotency_key: 'evidence-1' });
      expect(operation.status).toBe('queued');
      await expectPgError(
        db
          .updateTable('marketplace_operation')
          .set({ status: 'succeeded' })
          .where('id', '=', operation.id)
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_operation_succeeded_has_evidence',
      );
      await db
        .updateTable('marketplace_operation')
        .set({ status: 'succeeded', success_evidence: 'read_back' })
        .where('id', '=', operation.id)
        .execute();
    });

    it('requires a user-readable reason for failed and a next attempt for retrying', async () => {
      const operation = await insertOperation(db, a, { idempotency_key: 'failure-1' });
      await expectPgError(
        db
          .updateTable('marketplace_operation')
          .set({ status: 'failed', error_code: 'E_INVALID' })
          .where('id', '=', operation.id)
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_operation_failed_has_error',
      );
      await expectPgError(
        db
          .updateTable('marketplace_operation')
          .set({ status: 'retrying' })
          .where('id', '=', operation.id)
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_operation_retrying_has_next_attempt',
      );
    });

    it('never stores credentials on an assisted connection', async () => {
      await expectPgError(
        db
          .insertInto('marketplace_connection')
          .values({
            account_id: a.accountId,
            marketplace: 'poshmark',
            mode: 'assisted',
            token_ciphertext: Buffer.from('session-cookie'),
          })
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_connection_assisted_holds_no_token',
      );
    });

    it('keeps a session on a working automation connection, and none once it needs relinking', async () => {
      const connection = {
        account_id: a.accountId,
        marketplace: 'mercari' as const,
        mode: 'automation' as const,
      };
      await expectPgError(
        db.insertInto('marketplace_connection').values(connection).execute(),
        PG_ERROR.checkViolation,
        'marketplace_connection_automation_session',
      );
      await expectPgError(
        db
          .insertInto('marketplace_connection')
          .values({
            ...connection,
            status: 'reauth_required',
            token_ciphertext: Buffer.from('rejected-session'),
          })
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_connection_automation_session',
      );
      const linked = await db
        .insertInto('marketplace_connection')
        .values({ ...connection, token_ciphertext: Buffer.from('session') })
        .returning(['id', 'credential_version'])
        .executeTakeFirstOrThrow();
      expect(linked.credential_version).toBe(0);
      await db
        .updateTable('marketplace_connection')
        .set({ status: 'reauth_required', token_ciphertext: null })
        .where('id', '=', linked.id)
        .execute();
    });

    it('starts every new connection of a read-only marketplace read only, until it is turned off', async () => {
      const accountId = await insertAccount(db, 'RO');
      const session = {
        account_id: accountId,
        marketplace: 'depop' as const,
        mode: 'automation' as const,
        token_ciphertext: Buffer.from('session'),
      };
      const link = async () =>
        db
          .insertInto('marketplace_connection')
          .values(session)
          .returning(['id', 'read_only'])
          .executeTakeFirstOrThrow();
      const unlink = (id: string) =>
        db.deleteFrom('marketplace_connection').where('id', '=', id).execute();
      const setReadOnly = (id: string, readOnly: boolean) =>
        db
          .updateTable('marketplace_connection')
          .set({ read_only: readOnly })
          .where('id', '=', id)
          .execute();

      const first = await link();
      expect(first.read_only).toBe(false);
      await setReadOnly(first.id, true);
      // The connection goes (an unlink, the retention job, a purge); the setting stays.
      await unlink(first.id);
      const second = await link();
      expect(second.read_only).toBe(true);
      // Only the account's own marketplace: another account, or another marketplace, is unaffected.
      const other = await db
        .insertInto('marketplace_connection')
        .values({ ...session, marketplace: 'mercari' })
        .returning('read_only')
        .executeTakeFirstOrThrow();
      expect(other.read_only).toBe(false);
      // Turned off, the next link is writable.
      await setReadOnly(second.id, false);
      await unlink(second.id);
      expect((await link()).read_only).toBe(false);
      const held = await db
        .selectFrom('marketplace_read_only')
        .selectAll()
        .where('account_id', '=', accountId)
        .execute();
      expect(held).toEqual([]);
    });

    it('keeps read only by seller: a protected shop, and a seller the account kept read only', async () => {
      const accountId = await insertAccount(db, 'RS');
      const link = async (externalUserId: string | null = null) =>
        db
          .insertInto('marketplace_connection')
          .values({
            account_id: accountId,
            marketplace: 'depop',
            mode: 'automation',
            token_ciphertext: Buffer.from('session'),
            external_user_id: externalUserId,
          })
          .returning(['id', 'read_only'])
          .executeTakeFirstOrThrow();
      const set = (id: string, values: Updateable<MarketplaceConnectionTable>) =>
        db
          .updateTable('marketplace_connection')
          .set(values)
          .where('id', '=', id)
          .returning(['read_only', 'external_user_id'])
          .executeTakeFirstOrThrow();
      const unlink = (id: string) =>
        db.deleteFrom('marketplace_connection').where('id', '=', id).execute();

      // A seller the account kept read only: a connection that comes to hold it is read only again.
      const first = await link();
      await set(first.id, { external_user_id: 'rs-live-shop', read_only: true });
      await set(first.id, { external_user_id: 'rs-test-shop' });
      // The owner lets Listora change the test shop: only that seller is forgotten.
      expect(await set(first.id, { read_only: false })).toMatchObject({ read_only: false });
      expect(await set(first.id, { external_user_id: 'rs-live-shop' })).toMatchObject({
        read_only: true,
      });
      await set(first.id, { read_only: false });
      expect(await set(first.id, { external_user_id: 'rs-test-shop' })).toMatchObject({
        read_only: false,
      });
      expect(
        await db
          .selectFrom('read_only_seller')
          .select('seller_id')
          .where('account_id', '=', accountId)
          .execute(),
      ).toEqual([]);
      await unlink(first.id);

      // A protected shop known only by its connection: read only whatever sets it, and it learns
      // the seller from the connection's first recorded seller.
      const held = await link();
      const shop = await db
        .insertInto('protected_seller')
        .values({ marketplace: 'depop', connection_id: held.id, reason: 'test shop' })
        .returning('id')
        .executeTakeFirstOrThrow();
      try {
        expect(await set(held.id, { read_only: false })).toMatchObject({ read_only: true });
        await set(held.id, { external_user_id: 'rs-protected-shop' });
        expect(
          await db
            .selectFrom('protected_seller')
            .select('seller_id')
            .where('id', '=', shop.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ seller_id: 'rs-protected-shop' });
        // From then on the seller is protected, on any connection of any account.
        await unlink(held.id);
        await db.deleteFrom('marketplace_read_only').where('account_id', '=', accountId).execute();
        await db.deleteFrom('read_only_seller').where('account_id', '=', accountId).execute();
        expect((await link('rs-protected-shop')).read_only).toBe(true);
        const elsewhere = await insertAccount(db, 'RT');
        const theirs = await db
          .insertInto('marketplace_connection')
          .values({
            account_id: elsewhere,
            marketplace: 'depop',
            mode: 'automation',
            token_ciphertext: Buffer.from('session'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        expect(await set(theirs.id, { external_user_id: 'rs-protected-shop' })).toMatchObject({
          read_only: true,
        });
        // The same handle on another marketplace is another seller.
        const other = await db
          .insertInto('marketplace_connection')
          .values({
            account_id: elsewhere,
            marketplace: 'mercari',
            mode: 'automation',
            token_ciphertext: Buffer.from('session'),
            external_user_id: 'rs-protected-shop',
          })
          .returning('read_only')
          .executeTakeFirstOrThrow();
        expect(other.read_only).toBe(false);
      } finally {
        await db.deleteFrom('protected_seller').where('id', '=', shop.id).execute();
      }
    });

    it('links auto-delist operations to their delist run', async () => {
      await expectPgError(
        db
          .insertInto('marketplace_operation')
          .values({
            account_id: a.accountId,
            listing_id: a.listingId,
            kind: 'end',
            idempotency_key: 'auto-without-run',
            desired: jsonb({ status: 'ended' }),
            origin: 'auto_delist',
          })
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_operation_auto_delist_has_run',
      );
    });

    it('stores listing content exactly on the operations that publish it', async () => {
      const values = {
        account_id: a.accountId,
        listing_id: a.listingId,
        desired: jsonb({ status: 'active' }),
        origin: 'user',
      } as const;
      for (const kind of ['create', 'revise', 'relist'] as const) {
        await expectPgError(
          db
            .insertInto('marketplace_operation')
            .values({ ...values, kind, idempotency_key: `no-content-${kind}` })
            .execute(),
          PG_ERROR.checkViolation,
          'marketplace_operation_content_by_kind',
        );
      }
      await expectPgError(
        db
          .insertInto('marketplace_operation')
          .values({
            ...values,
            kind: 'end',
            idempotency_key: 'end-with-content',
            desired: jsonb({ status: 'ended' }),
            content: jsonb({ variant: { title: 'Jacket' } }),
          })
          .execute(),
        PG_ERROR.checkViolation,
        'marketplace_operation_content_by_kind',
      );
    });

    it('ties assisted edit tasks to their listing', async () => {
      await expectPgError(
        db
          .insertInto('user_task')
          .values({ account_id: a.accountId, kind: 'edit_manually' })
          .execute(),
        PG_ERROR.checkViolation,
        'user_task_manual_listing_task_has_listing',
      );
      await db
        .insertInto('user_task')
        .values({ account_id: a.accountId, kind: 'edit_manually', listing_id: a.listingId })
        .execute();
    });
  });

  describe('photos and uploads', () => {
    async function insertPhoto(storageKey: string) {
      return db
        .insertInto('photo')
        .values({
          account_id: a.accountId,
          item_id: a.itemId,
          position: 0,
          role: 'front',
          storage_key: storageKey,
          width: 10,
          height: 10,
          sha256: HASH,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
    }

    async function cleanUp(photoId: string) {
      await db.deleteFrom('photo').where('id', '=', photoId).execute();
    }

    it('starts photos as processing and makes ready ones carry their images', async () => {
      const photo = await insertPhoto('uploads/a/ready');
      expect(photo.status).toBe('processing');
      const update = (values: Updateable<PhotoTable>) =>
        db.updateTable('photo').set(values).where('id', '=', photo.id).execute();

      await expectPgError(
        update({ status: 'ready', processed_at: new Date(), phash: '0123456789abcdef' }),
        PG_ERROR.checkViolation,
        'photo_ready_has_images',
      );
      await expectPgError(
        update({ status: 'ready', phash: '0123456789abcdef', derivatives: jsonb(DERIVATIVES) }),
        PG_ERROR.checkViolation,
        'photo_processed_at_iff_processed',
      );
      await update({
        status: 'ready',
        processed_at: new Date(),
        phash: '0123456789abcdef',
        derivatives: jsonb(DERIVATIVES),
      });
      await cleanUp(photo.id);
    });

    it('makes failed photos carry a reason, and only failed ones', async () => {
      const photo = await insertPhoto('uploads/a/failed');
      const update = (values: Updateable<PhotoTable>) =>
        db.updateTable('photo').set(values).where('id', '=', photo.id).execute();
      await expectPgError(
        update({ status: 'failed', processed_at: new Date() }),
        PG_ERROR.checkViolation,
        'photo_failure_reason_iff_failed',
      );
      await expectPgError(
        update({ failure_reason: 'Not a JPEG.' }),
        PG_ERROR.checkViolation,
        'photo_failure_reason_iff_failed',
      );
      await update({ status: 'failed', processed_at: new Date(), failure_reason: 'Not a JPEG.' });
      await cleanUp(photo.id);
    });

    it('records upload files once, with timestamps that follow their status', async () => {
      const session = await db
        .insertInto('upload_session')
        .values({ account_id: a.accountId, expires_at: new Date(Date.now() + 60_000) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const file = {
        account_id: a.accountId,
        session_id: session.id,
        position: 0,
        content_type: 'image/jpeg' as const,
        byte_size: 100,
        sha256: HASH,
        storage_key: `uploads/${a.accountId}/one`,
      };
      const { id } = await db
        .insertInto('upload_file')
        .values(file)
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectPgError(
        db
          .insertInto('upload_file')
          .values({ ...file, position: 1 })
          .execute(),
        PG_ERROR.uniqueViolation,
        'upload_file_storage_key_key',
      );
      await expectPgError(
        db.updateTable('upload_file').set({ status: 'uploaded' }).where('id', '=', id).execute(),
        PG_ERROR.checkViolation,
        'upload_file_uploaded_at_iff_not_pending',
      );
      await expectPgError(
        db
          .updateTable('upload_file')
          .set({ status: 'attached', uploaded_at: new Date() })
          .where('id', '=', id)
          .execute(),
        PG_ERROR.checkViolation,
        'upload_file_attached_at_iff_attached',
      );
      await expectPgError(
        db
          .insertInto('upload_file')
          .values({ ...file, position: 2, storage_key: 'x', byte_size: 20 * 1024 * 1024 + 1 })
          .execute(),
        PG_ERROR.checkViolation,
      );
      await expectPgError(
        db
          .insertInto('upload_file')
          .values({ ...file, position: 2, storage_key: 'y', session_id: b.accountId })
          .execute(),
        PG_ERROR.foreignKeyViolation,
      );
    });
  });

  describe('append-only operation history', () => {
    it('accepts inserts but rejects updates and deletes', async () => {
      const operation = await insertOperation(db, a, { idempotency_key: 'history-1' });
      const event = await db
        .insertInto('operation_event')
        .values({
          account_id: a.accountId,
          operation_id: operation.id,
          to_status: 'queued',
          detail: jsonb({ note: 'created' }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await expectPgError(
        sql`update operation_event set to_status = 'succeeded' where id = ${event.id}`.execute(db),
        PG_ERROR.restrictViolation,
      );
      await expectPgError(
        db.deleteFrom('operation_event').where('id', '=', event.id).execute(),
        PG_ERROR.restrictViolation,
      );
      const rows = await db
        .selectFrom('operation_event')
        .select('to_status')
        .where('id', '=', event.id)
        .execute();
      expect(rows).toEqual([{ to_status: 'queued' }]);
    });

    it('keeps operations: a direct delete is rejected', async () => {
      const operation = await insertOperation(db, a, { idempotency_key: 'history-keep' });
      await db
        .insertInto('operation_event')
        .values({ account_id: a.accountId, operation_id: operation.id, to_status: 'queued' })
        .execute();
      await expectPgError(
        db.deleteFrom('marketplace_operation').where('id', '=', operation.id).execute(),
        PG_ERROR.restrictViolation,
      );
      const events = await db
        .selectFrom('operation_event')
        .select('to_status')
        .where('operation_id', '=', operation.id)
        .execute();
      expect(events).toEqual([{ to_status: 'queued' }]);
    });

    it('rejects history changes made by triggers other than foreign-key actions', async () => {
      const operation = await insertOperation(db, a, { idempotency_key: 'history-trigger' });
      await db
        .insertInto('operation_event')
        .values({ account_id: a.accountId, operation_id: operation.id, to_status: 'queued' })
        .execute();
      await sql`
        create function test_erase_history() returns trigger language plpgsql as $$
        begin
          delete from operation_event where account_id = new.account_id;
          return new;
        end;
        $$;
        create trigger test_erase_history after update on marketplace_listing
          for each row execute function test_erase_history();
      `.execute(db);
      try {
        await expectPgError(
          db
            .updateTable('marketplace_listing')
            .set({ title: 'erase' })
            .where('id', '=', a.listingId)
            .execute(),
          PG_ERROR.restrictViolation,
        );
      } finally {
        await sql`
          drop trigger test_erase_history on marketplace_listing;
          drop function test_erase_history();
        `.execute(db);
      }
    });

    it('lets foreign-key actions of a deleted parent change history', async () => {
      const item = await createInventoryItem(db, a.accountId);
      const user = await db
        .insertInto('app_user')
        .values({ auth_provider: 'dev', auth_subject: 'history-actor' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const entry = await db
        .insertInto('audit_log')
        .values({
          account_id: a.accountId,
          item_id: item.id,
          actor_kind: 'user',
          actor_user_id: user.id,
          action: 'item.created',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await db.deleteFrom('app_user').where('id', '=', user.id).execute();
      const kept = await db
        .selectFrom('audit_log')
        .select('actor_user_id')
        .where('id', '=', entry.id)
        .execute();
      expect(kept).toEqual([{ actor_user_id: null }]);

      await db.deleteFrom('inventory_item').where('id', '=', item.id).execute();
      const removed = await db.selectFrom('audit_log').where('id', '=', entry.id).execute();
      expect(removed).toEqual([]);
    });

    it('rejects updates to the audit log', async () => {
      const entry = await db
        .insertInto('audit_log')
        .values({
          account_id: a.accountId,
          item_id: a.itemId,
          actor_kind: 'system',
          action: 'item.created',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectPgError(
        sql`update audit_log set action = 'item.deleted' where id = ${entry.id}`.execute(db),
        PG_ERROR.restrictViolation,
      );
    });
  });

  describe('account deletion', () => {
    it("deletes all of the account's data, including append-only history, and nothing else", async () => {
      const doomed = await seedAccount(db, 'DEL');
      const kept = await seedAccount(db, 'KEP');
      for (const seed of [doomed, kept]) {
        await db
          .insertInto('inbound_event')
          .values({
            account_id: seed.accountId,
            source: 'ebay_webhook',
            marketplace: 'ebay',
            provider_event_id: `evt-${seed.accountId}`,
            signature_ok: true,
            payload: jsonb({}),
          })
          .execute();
        const saleId = await insertSale(db, seed.accountId, `order-${seed.accountId}`);
        const sold = await insertSaleItem(db, seed.accountId, saleId, seed);
        await db
          .insertInto('fee_line')
          .values({
            account_id: seed.accountId,
            sale_id: saleId,
            sale_item_id: sold.id,
            kind: 'marketplace',
            amount_cents: 600,
            source: 'actual',
          })
          .execute();
        const run = await db
          .insertInto('delist_run')
          .values({ account_id: seed.accountId, sale_id: saleId, item_id: seed.itemId })
          .returning('id')
          .executeTakeFirstOrThrow();
        const operation = await db
          .insertInto('marketplace_operation')
          .values({
            account_id: seed.accountId,
            listing_id: seed.listingId,
            kind: 'end',
            idempotency_key: `delist-${run.id}`,
            desired: jsonb({ status: 'ended' }),
            origin: 'auto_delist',
            delist_run_id: run.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db
          .insertInto('operation_event')
          .values({ account_id: seed.accountId, operation_id: operation.id, to_status: 'queued' })
          .execute();
        await db
          .insertInto('user_task')
          .values({
            account_id: seed.accountId,
            kind: 'delist_manually',
            item_id: seed.itemId,
            listing_id: seed.listingId,
            delist_run_id: run.id,
            urgency: 'urgent',
          })
          .execute();
        await db
          .insertInto('audit_log')
          .values({
            account_id: seed.accountId,
            item_id: seed.itemId,
            actor_kind: 'user',
            action: 'item.sold',
          })
          .execute();

        const results = await db
          .selectFrom('delist_run_listing')
          .select(['source', 'status'])
          .where('delist_run_id', '=', run.id)
          .orderBy('source')
          .execute();
        expect(results).toEqual([
          { source: 'operation', status: 'queued' },
          { source: 'user_task', status: 'open' },
        ]);
      }

      await db.deleteFrom('account').where('id', '=', doomed.accountId).execute();

      const tables = await sql<{ table_name: string }>`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'account_id'
        order by table_name
      `.execute(db);
      const rows = [];
      for (const { table_name } of tables.rows) {
        const count = async (accountId: string) =>
          (
            await sql<{ count: number }>`
              select count(*) as count from ${sql.table(table_name)} where account_id = ${accountId}
            `.execute(db)
          ).rows[0]?.count;
        rows.push({
          table_name,
          doomed: await count(doomed.accountId),
          kept: await count(kept.accountId),
        });
      }
      expect(rows.filter((row) => row.doomed !== 0)).toEqual([]);
      expect(rows.filter((row) => (row.kept ?? 0) > 0).map((row) => row.table_name)).toEqual(
        expect.arrayContaining([
          'audit_log',
          'delist_run',
          'fee_line',
          'inbound_event',
          'inventory_item',
          'marketplace_listing',
          'marketplace_operation',
          'operation_event',
          'sale',
          'sale_item',
          'sku_sequence',
          'user_task',
        ]),
      );
    });
  });
});
