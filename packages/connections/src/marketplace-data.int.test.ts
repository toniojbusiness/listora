/**
 * The owner's unlink removes the marketplace's data from the account, on real Postgres
 * (docs/features/privacy.md, Unlinking a marketplace): its listings, the items only its import
 * brought in, its sales with their Pack check orders, its offers, tasks, events, sale checks, and
 * the item history that names it; the history of what Listora did there stays, for the owner only,
 * marked as from an unlinked account. Another marketplace's data, and another account's, are
 * untouched, and nothing is asked of the marketplace.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInventoryItem, jsonb, type Db, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';
import { LocalDiskStorage } from '@listora/storage';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { completeConnectionDeletion, startConnectionDeletion } from './deletion.ts';

const logger = createLogger({ service: 'marketplace-data-test', level: 'silent' });

describe("unlinking removes the marketplace's data (real Postgres)", () => {
  let database: MigratedDatabase;
  let db: Db;
  let storageDir: string;
  let storage: LocalDiskStorage;

  beforeAll(async () => {
    database = await createMigratedDatabase('marketplace_data', { jobQueue: true });
    db = database.db;
    storageDir = await mkdtemp(join(tmpdir(), 'listora-marketplace-data-'));
    storage = new LocalDiskStorage({
      rootDir: storageDir,
      baseUrl: 'http://127.0.0.1:3000',
      signingSecret: 'marketplace-data-test-secret-0123456789',
    });
  });

  afterAll(async () => {
    await database.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  async function connect(accountId: string, marketplace: Marketplace): Promise<string> {
    const { id } = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace,
        mode: 'automation',
        external_user_id: `${marketplace}-shop`,
        token_ciphertext: Buffer.from('sealed session'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_check_schedule')
      .values({
        account_id: accountId,
        connection_id: id,
        marketplace,
        next_check_at: new Date(),
        next_reason: 'linked',
      })
      .execute();
    await db
      .insertInto('sale_check_run')
      .values({
        account_id: accountId,
        connection_id: id,
        marketplace,
        kind: 'history',
        host: 'runner',
      })
      .execute();
    await db
      .insertInto('background_read_health')
      .values({ account_id: accountId, connection_id: id, marketplace, read: 'sale_check' })
      .execute();
    await db
      .insertInto('inbound_event')
      .values([
        {
          account_id: accountId,
          source: 'poll',
          marketplace,
          provider_event_id: `history:order:${marketplace}-1`,
          payload: jsonb({ orderId: `${marketplace}-1` }),
        },
        {
          account_id: accountId,
          source: 'email',
          marketplace,
          provider_event_id: `email:${marketplace}-1`,
          signature_ok: true,
          payload: jsonb({ subject: 'It sold' }),
        },
      ])
      .execute();
    await db
      .insertInto('user_task')
      .values({
        account_id: accountId,
        kind: 'reconnect',
        deep_link: `listora://connections/${marketplace}`,
        payload: jsonb({ connectionId: id, marketplace }),
      })
      .execute();
    return id;
  }

  /** An item, made in Listora or imported from `importedFrom` (its audit entry says which). */
  async function item(
    accountId: string,
    title: string,
    importedFrom?: Marketplace,
  ): Promise<{ id: string; photoKeys: string[] }> {
    const created = await createInventoryItem(db, accountId, { title, status: 'ready' });
    await db
      .insertInto('audit_log')
      .values({
        account_id: accountId,
        item_id: created.id,
        actor_kind: importedFrom === undefined ? 'user' : 'marketplace',
        action: importedFrom === undefined ? 'item.created' : 'item.imported',
        changes: jsonb(importedFrom === undefined ? {} : { marketplace: importedFrom }),
      })
      .execute();
    const photoKeys = [`photos/${accountId}/${created.id}/original.jpg`];
    const derivative = `photos/${accountId}/${created.id}/thumbnail.jpg`;
    for (const key of [...photoKeys, derivative]) {
      await storage.put(key, new Uint8Array([255, 216, 255]), { contentType: 'image/jpeg' });
    }
    await db
      .insertInto('photo')
      .values({
        account_id: accountId,
        item_id: created.id,
        position: 0,
        role: 'front',
        storage_key: photoKeys[0] ?? '',
        derivatives: jsonb({ thumbnail: { key: derivative, width: 640, height: 640 } }),
      })
      .execute();
    return { id: created.id, photoKeys: [...photoKeys, derivative] };
  }

  async function listing(
    accountId: string,
    itemId: string,
    marketplace: Marketplace,
    connectionId: string | null,
    status: 'active' | 'sold' | 'ended' = 'active',
  ): Promise<string> {
    const { id } = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: itemId,
        marketplace,
        connection_id: connectionId,
        status,
        external_listing_id: `${marketplace}-${itemId}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('inventory_item')
      .set({ status: status === 'active' ? 'listed' : 'sold' })
      .where('id', '=', itemId)
      .where('status', '=', 'ready')
      .execute();
    return id;
  }

  async function operation(
    accountId: string,
    listingId: string,
    values: {
      kind: 'price' | 'end' | 'refresh';
      status: 'queued' | 'running' | 'needs_user_action' | 'succeeded';
      delistRunId?: string;
    },
  ): Promise<string> {
    const { id } = await db
      .insertInto('marketplace_operation')
      .values({
        account_id: accountId,
        listing_id: listingId,
        kind: values.kind,
        idempotency_key: `op-${crypto.randomUUID()}`,
        desired: jsonb(values.kind === 'price' ? { priceCents: 2500 } : {}),
        status: values.status,
        success_evidence: values.status === 'succeeded' ? 'read_back' : null,
        origin: values.delistRunId === undefined ? 'user' : 'auto_delist',
        delist_run_id: values.delistRunId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('operation_event')
      .values({ account_id: accountId, operation_id: id, to_status: 'queued' })
      .execute();
    return id;
  }

  /** A sale of the item on `marketplace`, with its fee, label, and package (and its photo). */
  async function sale(
    accountId: string,
    itemId: string,
    marketplace: Marketplace,
    listingId: string,
  ): Promise<{ saleId: string; runId: string; packagePhoto: string }> {
    const { id: saleId } = await db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace,
        external_order_id: `order-${itemId}`,
        sold_at: new Date(),
        detection_source: 'poll',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { id: saleItemId } = await db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: saleId,
        marketplace,
        item_id: itemId,
        listing_id: listingId,
        sale_price_cents: 4000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('fee_line')
      .values({
        account_id: accountId,
        sale_id: saleId,
        sale_item_id: saleItemId,
        kind: 'marketplace',
        amount_cents: 400,
        source: 'estimated',
      })
      .execute();
    const { id: runId } = await db
      .insertInto('delist_run')
      .values({ account_id: accountId, sale_id: saleId, item_id: itemId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const packagePhoto = `packages/${accountId}/${saleId}.jpg`;
    await storage.put(packagePhoto, new Uint8Array([255, 216, 255]), {
      contentType: 'image/jpeg',
    });
    await db
      .insertInto('sale_label')
      .values({ account_id: accountId, sale_id: saleId, buyer_first_name: 'Sam' })
      .execute();
    await db
      .insertInto('sale_pack')
      .values({
        account_id: accountId,
        sale_id: saleId,
        tracking_number: `1Z${saleItemId.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
        matched_by: 'label',
        photo_key: packagePhoto,
        photo_added_at: new Date(),
      })
      .execute();
    await db
      .insertInto('audit_log')
      .values({
        account_id: accountId,
        item_id: itemId,
        actor_kind: 'marketplace',
        action: 'item.sold',
        changes: jsonb({ saleId, marketplace, delistRunId: runId }),
      })
      .execute();
    await db
      .updateTable('inventory_item')
      .set({ status: 'sold_pending_delist' })
      .where('id', '=', itemId)
      .execute();
    return { saleId, runId, packagePhoto };
  }

  /** A seller with Depop and Poshmark linked, every kind of Depop data, and some Poshmark data. */
  async function seller() {
    const accountId = await insertAccount(db);
    const depop = await connect(accountId, 'depop');
    const poshmark = await connect(accountId, 'poshmark');

    // Imported from Depop, listed nowhere else: it goes, with its photos, offer, and task.
    const imported = await item(accountId, 'Imported dress', 'depop');
    const importedListing = await listing(accountId, imported.id, 'depop', depop);
    const { id: offerId } = await db
      .insertInto('marketplace_offer')
      .values({
        account_id: accountId,
        connection_id: depop,
        marketplace: 'depop',
        external_offer_id: 'offer-1',
        listing_id: importedListing,
        item_id: imported.id,
        amount_cents: 2000,
        buyer_name: 'buyer_one',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('user_task')
      .values({
        account_id: accountId,
        kind: 'answer_offer',
        offer_id: offerId,
        item_id: imported.id,
        listing_id: importedListing,
        payload: jsonb({}),
      })
      .execute();
    const { id: importId } = await db
      .insertInto('listing_import')
      .values({
        account_id: accountId,
        connection_id: depop,
        marketplace: 'depop',
        host: 'runner',
        status: 'finished',
        read_at: new Date(),
        finished_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('listing_import_entry')
      .values({
        account_id: accountId,
        import_id: importId,
        marketplace: 'depop',
        external_listing_id: `depop-${imported.id}`,
        listing: jsonb({ title: 'Imported dress' }),
        outcome: 'imported',
        item_id: imported.id,
        listing_id: importedListing,
        settled_at: new Date(),
      })
      .execute();
    // A sold item of the Depop sales history: it goes with its sale, label, and package.
    const sold = await item(accountId, 'Sold jacket', 'depop');
    const soldListing = await listing(accountId, sold.id, 'depop', depop, 'sold');
    const soldSale = await sale(accountId, sold.id, 'depop', soldListing);

    // Made in Listora, listed on both: it stays, on Poshmark only; Depop's operations settle.
    const own = await item(accountId, 'Own sweater');
    const ownDepop = await listing(accountId, own.id, 'depop', depop);
    const ownPoshmark = await listing(accountId, own.id, 'poshmark', poshmark);
    await db
      .insertInto('audit_log')
      .values({
        account_id: accountId,
        item_id: own.id,
        actor_kind: 'user',
        action: 'listing.created',
        changes: jsonb({ marketplace: 'depop', listingId: ownDepop }),
      })
      .execute();
    const succeeded = await operation(accountId, ownDepop, {
      kind: 'price',
      status: 'succeeded',
    });
    const queued = await operation(accountId, ownDepop, { kind: 'price', status: 'queued' });
    const waiting = await operation(accountId, ownDepop, {
      kind: 'end',
      status: 'needs_user_action',
    });
    await db
      .insertInto('user_task')
      .values({
        account_id: accountId,
        kind: 'delist_manually',
        item_id: own.id,
        listing_id: ownDepop,
        operation_id: waiting,
        payload: jsonb({}),
      })
      .execute();
    const poshmarkPrice = await operation(accountId, ownPoshmark, {
      kind: 'price',
      status: 'queued',
    });

    // Imported from Depop but listed on Poshmark too: it stays, on Poshmark only.
    const crosslisted = await item(accountId, 'Crosslisted boots', 'depop');
    await listing(accountId, crosslisted.id, 'depop', depop);
    await listing(accountId, crosslisted.id, 'poshmark', poshmark);

    // Made in Listora, listed only on Depop, a refresh under way: it stays, ready again.
    const onlyDepop = await item(accountId, 'Only on Depop');
    const onlyDepopListing = await listing(accountId, onlyDepop.id, 'depop', depop);
    const running = await operation(accountId, onlyDepopListing, {
      kind: 'refresh',
      status: 'running',
    });

    // Made in Listora, sold on Depop, its Poshmark listing being delisted: the sale goes, the
    // delist stays without its run, and the item is sold.
    const soldOwn = await item(accountId, 'Own coat');
    const soldOwnDepop = await listing(accountId, soldOwn.id, 'depop', depop);
    const soldOwnPoshmark = await listing(accountId, soldOwn.id, 'poshmark', poshmark);
    await db
      .updateTable('marketplace_listing')
      .set({ status: 'sold' })
      .where('id', '=', soldOwnDepop)
      .execute();
    const depopSale = await sale(accountId, soldOwn.id, 'depop', soldOwnDepop);
    const delistOnPoshmark = await operation(accountId, soldOwnPoshmark, {
      kind: 'end',
      status: 'queued',
      delistRunId: depopSale.runId,
    });

    // Sold on Poshmark, its Depop listing being delisted: the sale and run stay, the Depop delist
    // is canceled with its listing.
    const poshmarkSold = await item(accountId, 'Poshmark bag');
    const poshmarkSoldPoshmark = await listing(accountId, poshmarkSold.id, 'poshmark', poshmark);
    const poshmarkSoldDepop = await listing(accountId, poshmarkSold.id, 'depop', depop);
    await db
      .updateTable('marketplace_listing')
      .set({ status: 'sold' })
      .where('id', '=', poshmarkSoldPoshmark)
      .execute();
    const poshmarkSale = await sale(accountId, poshmarkSold.id, 'poshmark', poshmarkSoldPoshmark);
    const delistOnDepop = await operation(accountId, poshmarkSoldDepop, {
      kind: 'end',
      status: 'queued',
      delistRunId: poshmarkSale.runId,
    });

    // A sale email's question about Depop, and a double sale whose earlier sale was on Depop.
    await db
      .insertInto('user_task')
      .values([
        {
          account_id: accountId,
          kind: 'review_match',
          payload: jsonb({ marketplace: 'depop', inboundEventId: crypto.randomUUID() }),
        },
        {
          account_id: accountId,
          kind: 'resolve_double_sale',
          item_id: soldOwn.id,
          sale_id: poshmarkSale.saleId,
          payload: jsonb({ marketplace: 'poshmark', earlierMarketplace: 'depop' }),
        },
      ])
      .execute();

    return {
      accountId,
      depop,
      poshmark,
      items: { imported, sold, own, crosslisted, onlyDepop, soldOwn, poshmarkSold },
      listings: { ownPoshmark, soldOwnPoshmark, poshmarkSoldPoshmark, ownDepop },
      operations: {
        succeeded,
        queued,
        waiting,
        running,
        delistOnPoshmark,
        delistOnDepop,
        poshmarkPrice,
      },
      sales: { soldSale, depopSale, poshmarkSale },
    };
  }

  /** Every row of the account that is about `marketplace`, by table. */
  async function marketplaceRows(accountId: string, marketplace: Marketplace) {
    const { rows } = await sql<{ table_name: string; count: number }>`
      select table_name, count(*)::int as count from (
        select 'marketplace_listing' as table_name from marketplace_listing
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'sale' from sale
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'sale_item' from sale_item
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'marketplace_offer' from marketplace_offer
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'inbound_event' from inbound_event
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'sale_check_schedule' from sale_check_schedule
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'sale_check_run' from sale_check_run
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'listing_import' from listing_import
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'listing_import_entry' from listing_import_entry
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'background_read_health' from background_read_health
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'marketplace_connection' from marketplace_connection
          where account_id = ${accountId} and marketplace = ${marketplace}
        union all select 'user_task' from user_task
          where account_id = ${accountId}
            and (payload ->> 'marketplace' = ${marketplace}
              or payload ->> 'earlierMarketplace' = ${marketplace}
              or listing_id in (select id from marketplace_listing
                where account_id = ${accountId} and marketplace = ${marketplace}))
        union all select 'audit_log' from audit_log
          where account_id = ${accountId} and changes ->> 'marketplace' = ${marketplace}
      ) as rows
      group by table_name
      order by table_name
    `.execute(db);
    return Object.fromEntries(rows.map((row) => [row.table_name, row.count]));
  }

  const unlink = (accountId: string, connectionId: string) =>
    db.transaction().execute(async (trx) => {
      const started = await startConnectionDeletion(trx, {
        accountId,
        connectionId,
        reason: 'unlinked',
      });
      if (started === undefined) throw new Error('nothing unlinked');
      return started;
    });

  it('removes every piece of the marketplace, keeps its history for the owner, and touches nothing else', async () => {
    const seeded = await seller();
    const other = await seller();
    const poshmarkBefore = await marketplaceRows(seeded.accountId, 'poshmark');
    const otherBefore = {
      depop: await marketplaceRows(other.accountId, 'depop'),
      poshmark: await marketplaceRows(other.accountId, 'poshmark'),
    };

    const started = await unlink(seeded.accountId, seeded.depop);
    expect(started.deleted.marketplaceData).toMatchObject({
      listings: 7,
      settledOperations: 4,
      items: 2,
      sales: 2,
    });

    expect(await marketplaceRows(seeded.accountId, 'depop')).toEqual({});
    // Poshmark keeps everything but the double sale, whose earlier sale (on Depop) is gone.
    expect(await marketplaceRows(seeded.accountId, 'poshmark')).toEqual({
      ...poshmarkBefore,
      user_task: (poshmarkBefore['user_task'] ?? 0) - 1,
    });
    expect(await marketplaceRows(other.accountId, 'depop')).toEqual(otherBefore.depop);
    expect(await marketplaceRows(other.accountId, 'poshmark')).toEqual(otherBefore.poshmark);

    // Only the items Depop's import brought in, and that are nowhere else, go.
    const items = await db
      .selectFrom('inventory_item')
      .select(['id', 'title', 'status'])
      .where('account_id', '=', seeded.accountId)
      .orderBy('title')
      .execute();
    expect(items.map((row) => [row.title, row.status])).toEqual([
      ['Crosslisted boots', 'listed'],
      ['Only on Depop', 'ready'],
      ['Own coat', 'sold'],
      ['Own sweater', 'listed'],
      ['Poshmark bag', 'sold_pending_delist'],
    ]);
    const { imported, sold, own } = seeded.items;
    for (const gone of [imported, sold]) {
      const photos = await db
        .selectFrom('photo')
        .select('id')
        .where('item_id', '=', gone.id)
        .execute();
      expect(photos).toEqual([]);
    }
    // The items that stay keep their own history; what named Depop is gone.
    const ownHistory = await db
      .selectFrom('audit_log')
      .select('action')
      .where('item_id', '=', own.id)
      .execute();
    expect(ownHistory.map((row) => row.action)).toEqual(['item.created']);

    // The Poshmark sale's delist run stays (without the Depop listing); the Depop sale's went.
    const poshmarkRun = await db
      .selectFrom('delist_run')
      .select('id')
      .where('sale_id', '=', seeded.sales.poshmarkSale.saleId)
      .executeTakeFirst();
    expect(poshmarkRun?.id).toBe(seeded.sales.poshmarkSale.runId);
    const runs = await db
      .selectFrom('delist_run')
      .select('id')
      .where('account_id', '=', seeded.accountId)
      .execute();
    expect(runs).toHaveLength(1);

    // What Listora did on Depop stays, for the owner: settled without asking Depop, on records
    // marked as from an unlinked account.
    const operations = await db
      .selectFrom('marketplace_operation as op')
      .innerJoin('deleted_listing as deleted', 'deleted.id', 'op.deleted_listing_id')
      .select([
        'op.id',
        'op.status',
        'op.error_code',
        'op.listing_id',
        'op.delist_run_id',
        'deleted.reason',
        'deleted.marketplace',
      ])
      .where('op.account_id', '=', seeded.accountId)
      .execute();
    const byId = new Map(operations.map((row) => [row.id, row]));
    const { operations: ops } = seeded;
    expect(byId.get(ops.succeeded)).toMatchObject({ status: 'succeeded', listing_id: null });
    expect(byId.get(ops.queued)).toMatchObject({ status: 'canceled', reason: 'unlinked' });
    expect(byId.get(ops.waiting)).toMatchObject({ status: 'canceled' });
    expect(byId.get(ops.running)).toMatchObject({
      status: 'failed',
      error_code: 'marketplace_unlinked',
    });
    expect(byId.get(ops.delistOnDepop)).toMatchObject({
      status: 'canceled',
      delist_run_id: seeded.sales.poshmarkSale.runId,
      marketplace: 'depop',
    });
    expect(operations.every((row) => row.reason === 'unlinked')).toBe(true);
    const events = await db
      .selectFrom('operation_event')
      .select(['to_status', 'detail'])
      .where('operation_id', '=', ops.running)
      .orderBy('created_at')
      .execute();
    expect(events.at(-1)).toMatchObject({
      to_status: 'failed',
      detail: { action: 'unlink', reason: 'marketplace_unlinked' },
    });
    const deletedItems = await db
      .selectFrom('deleted_item')
      .select(['id', 'reason'])
      .where('account_id', '=', seeded.accountId)
      .orderBy('id')
      .execute();
    expect(deletedItems).toEqual(
      [imported.id, sold.id].sort().map((id) => ({ id, reason: 'unlinked' })),
    );

    // Poshmark's operations are untouched; the delist the Depop sale started stays, without its
    // run (the item did sell).
    const tracked = await db
      .selectFrom('marketplace_operation')
      .select(['id', 'status', 'origin', 'delist_run_id', 'listing_id'])
      .where('id', 'in', [ops.delistOnPoshmark, ops.poshmarkPrice])
      .orderBy('id')
      .execute();
    expect(tracked).toEqual(
      [
        {
          id: ops.delistOnPoshmark,
          status: 'queued',
          origin: 'auto_delist',
          delist_run_id: null,
          listing_id: seeded.listings.soldOwnPoshmark,
        },
        {
          id: ops.poshmarkPrice,
          status: 'queued',
          origin: 'user',
          delist_run_id: null,
          listing_id: seeded.listings.ownPoshmark,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );

    // The job deletes the photos of the items that went and the Depop package photos, then
    // completes: no row references the connection.
    const removedObjects = [
      ...imported.photoKeys,
      ...sold.photoKeys,
      seeded.sales.soldSale.packagePhoto,
      seeded.sales.depopSale.packagePhoto,
    ];
    const queuedObjects = await db
      .selectFrom('connection_deletion_object')
      .select('storage_key')
      .where('deletion_id', '=', started.deletionId)
      .execute();
    expect(queuedObjects.map((row) => row.storage_key).sort()).toEqual(removedObjects.sort());
    const outcome = await completeConnectionDeletion(
      { db, revoker: undefined, storage, logger },
      started.deletionId,
    );
    expect(outcome).toBe('completed');
    for (const key of removedObjects) expect(await storage.head(key)).toBeFalsy();
    expect(await storage.head(seeded.sales.poshmarkSale.packagePhoto)).toBeTruthy();
    expect(await storage.head(own.photoKeys[0] ?? '')).toBeTruthy();
  });

  it("keeps the seller's records when the connection goes another way (access revoked)", async () => {
    const seeded = await seller();
    const before = await marketplaceRows(seeded.accountId, 'depop');
    await db.transaction().execute((trx) =>
      startConnectionDeletion(trx, {
        accountId: seeded.accountId,
        connectionId: seeded.depop,
        reason: 'revoked',
      }),
    );
    const after = await marketplaceRows(seeded.accountId, 'depop');
    expect(after).toMatchObject({
      marketplace_listing: before['marketplace_listing'],
      sale: before['sale'],
      sale_item: before['sale_item'],
    });
    expect(after['marketplace_connection']).toBeUndefined();
  });
});
