import { randomUUID } from 'node:crypto';

import { createInventoryItem, inTransaction, jsonb, type Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { changeSale } from '@listora/sales';
import { createLogger } from '@listora/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RETENTION_DAYS, runDataRetention } from './retention.ts';

const DAY = 86_400_000;
const logger = createLogger({ service: 'retention-test', level: 'silent' });

describe('data retention job (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createMigratedDatabase('retention', { jobQueue: true });
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  /** `days` days ago (a little more, so the boundary is not in question). */
  const ago = (days: number): Date => new Date(Date.now() - days * DAY - 60_000);

  async function account(): Promise<{ accountId: string; itemId: string; listingId: string }> {
    const accountId = await insertAccount(db);
    const item = await createInventoryItem(db, accountId);
    const listing = await db
      .insertInto('marketplace_listing')
      .values({ account_id: accountId, item_id: item.id, marketplace: 'ebay' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { accountId, itemId: item.id, listingId: listing.id };
  }

  async function operation(
    seeded: { accountId: string; listingId: string },
    status: 'failed' | 'queued',
    updatedAt: Date,
  ): Promise<string> {
    // `updated_at` is the database's; set it straight in SQL (its trigger runs on updates only).
    const failed = status === 'failed';
    const { rows } = await sql<{ id: string }>`
      insert into marketplace_operation
        (account_id, listing_id, kind, idempotency_key, desired, status, origin, error_code,
         error_message, updated_at)
      values (${seeded.accountId}, ${seeded.listingId}, 'end', ${randomUUID()}, '{}', ${status},
        'user', ${failed ? 'listing_not_found' : null}, ${failed ? 'eBay no longer has it.' : null},
        ${updatedAt})
      returning id
    `.execute(db);
    const row = rows[0];
    if (row === undefined) throw new Error('no operation');
    return row.id;
  }

  async function event(
    accountId: string,
    operationId: string,
    createdAt: Date,
    detail: Record<string, string> = { request: 'EndItem', response: 'Ack' },
  ): Promise<string> {
    const row = await db
      .insertInto('operation_event')
      .values({
        account_id: accountId,
        operation_id: operationId,
        to_status: 'running',
        detail: jsonb(detail),
        created_at: createdAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function ids(
    table: 'operation_event' | 'inbound_event' | 'ai_usage_event' | 'sale_check_run' | 'item_scan',
    of: string[],
  ) {
    const { rows } = await sql<{ id: string }>`
      select id from ${sql.table(table)} where id = any(${of}::uuid[]) order by id
    `.execute(db);
    return rows.map((row) => row.id);
  }

  it('deletes settled operations’ old history, keeping recent events, open operations, and named ids', async () => {
    const seeded = await account();
    const keep = RETENTION_DAYS.operationEvents;
    const settled = await operation(seeded, 'failed', ago(keep + 5));
    const open = await operation(seeded, 'queued', ago(keep + 5));
    const old = await event(seeded.accountId, settled, ago(keep + 10));
    const named = await event(seeded.accountId, settled, ago(keep + 10), {
      namedListingId: 'AJ-000184-D1',
    });
    const recentlySettled = await operation(seeded, 'failed', ago(1));
    const oldOfRecent = await event(seeded.accountId, recentlySettled, ago(keep + 10));
    const ofOpen = await event(seeded.accountId, open, ago(keep + 10));
    const recent = await event(seeded.accountId, settled, ago(keep - 1));

    const summary = await runDataRetention({ db, logger });
    expect(summary.operationEvents).toBeGreaterThanOrEqual(1);
    expect(await ids('operation_event', [old, named, oldOfRecent, ofOpen, recent])).toEqual(
      [named, oldOfRecent, ofOpen, recent].sort(),
    );
    // The operation itself, with its final status and error, stays.
    const operations = await db
      .selectFrom('marketplace_operation')
      .select(['id', 'status', 'error_message'])
      .where('id', '=', settled)
      .execute();
    expect(operations).toEqual([
      { id: settled, status: 'failed', error_message: 'eBay no longer has it.' },
    ]);
  });

  it('still rejects every other delete of the append-only tables', async () => {
    const seeded = await account();
    const settled = await operation(seeded, 'failed', ago(1));
    const id = await event(seeded.accountId, settled, ago(1));
    await expect(db.deleteFrom('operation_event').where('id', '=', id).execute()).rejects.toThrow(
      /operation_event: direct delete is not allowed/,
    );
    // The setting allows only the table it names, and only deletes.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`select set_config('listora.retention_delete', 'ai_usage_event', true)`.execute(
          trx,
        );
        await trx.deleteFrom('operation_event').where('id', '=', id).execute();
      }),
    ).rejects.toThrow(/direct delete is not allowed/);
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`select set_config('listora.retention_delete', 'operation_event', true)`.execute(
          trx,
        );
        await sql`update operation_event set attempt = 9 where id = ${id}`.execute(trx);
      }),
    ).rejects.toThrow(/direct update is not allowed/);
    await db
      .insertInto('audit_log')
      .values({ account_id: seeded.accountId, actor_kind: 'user', action: 'item.updated' })
      .execute();
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`select set_config('listora.retention_delete', 'operation_event', true)`.execute(
          trx,
        );
        await trx.deleteFrom('audit_log').where('account_id', '=', seeded.accountId).execute();
      }),
    ).rejects.toThrow(/audit_log: direct delete is not allowed/);
  });

  it('deletes processed raw payloads after 90 days, never unprocessed ones', async () => {
    const { accountId } = await account();
    const inbound = async (processedAt: Date | null) =>
      (
        await db
          .insertInto('inbound_event')
          .values({
            account_id: accountId,
            source: 'poll',
            marketplace: 'ebay',
            provider_event_id: randomUUID(),
            payload: jsonb({ orderId: '12-34567-89012' }),
            processed_at: processedAt,
            result: processedAt === null ? null : 'processed',
            created_at: ago(200),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const old = await inbound(ago(RETENTION_DAYS.inboundEvents + 1));
    const recent = await inbound(ago(RETENTION_DAYS.inboundEvents - 1));
    const unprocessed = await inbound(null);

    await runDataRetention({ db, logger });
    expect(await ids('inbound_event', [old, recent, unprocessed])).toEqual(
      [recent, unprocessed].sort(),
    );
  });

  it('deletes sale-check records 90 days after the check, keeping the sale that one saw', async () => {
    const { accountId, itemId } = await account();
    const connection = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'mercari',
        mode: 'automation',
        display_name: 'Mercari',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const check = async (startedAt: Date) =>
      (
        await db
          .insertInto('sale_check_run')
          .values({
            account_id: accountId,
            connection_id: connection.id,
            marketplace: 'mercari',
            kind: 'scheduled',
            reason: 'scheduled',
            host: 'phone',
            started_at: startedAt,
            finished_at: startedAt,
            outcome: 'succeeded',
            orders_seen: 1,
            items_seen: 1,
            new_orders: 1,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const old = await check(ago(RETENTION_DAYS.saleCheckRuns + 1));
    const recent = await check(ago(RETENTION_DAYS.saleCheckRuns - 1));
    const sale = await db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace: 'mercari',
        external_order_id: randomUUID(),
        sold_at: ago(RETENTION_DAYS.saleCheckRuns + 1),
        detection_source: 'poll',
        sale_check_run_id: old,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: sale.id,
        marketplace: 'mercari',
        item_id: itemId,
        sale_price_cents: 2500,
      })
      .execute();

    await runDataRetention({ db, logger });
    expect(await ids('sale_check_run', [old, recent])).toEqual([recent]);
    const kept = await db
      .selectFrom('sale')
      .select(['detection_source', 'sale_check_run_id'])
      .where('id', '=', sale.id)
      .executeTakeFirstOrThrow();
    expect(kept).toEqual({ detection_source: 'poll', sale_check_run_id: null });
  });

  it('deletes AI usage events after 400 days and keeps the daily totals', async () => {
    const { accountId } = await account();
    const usage = async (createdAt: Date) =>
      (
        await db
          .insertInto('ai_usage_event')
          .values({
            account_id: accountId,
            purpose: 'item_analysis',
            provider: 'fake',
            model: 'claude-haiku-5-5',
            tier: 'standard',
            outcome: 'succeeded',
            cost_micros: 1500,
            price_table_version: 'test',
            created_at: createdAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const old = await usage(ago(RETENTION_DAYS.aiUsageEvents + 1));
    const recent = await usage(ago(RETENTION_DAYS.aiUsageEvents - 1));
    const totals = () =>
      db
        .selectFrom('ai_usage_daily')
        .select(['usage_date', 'calls', 'cost_micros'])
        .where('account_id', '=', accountId)
        .orderBy('usage_date')
        .execute();
    const before = await totals();
    expect(before).toHaveLength(2);

    await runDataRetention({ db, logger });
    expect(await ids('ai_usage_event', [old, recent])).toEqual([recent]);
    expect(await totals()).toEqual(before);
  });

  it('deletes thrift scans never kept after 90 days, and their web research past use, keeping kept ones and the run counts', async () => {
    const { accountId, itemId } = await account();
    const run = await db
      .insertInto('sourcing_run')
      .values({ account_id: accountId, scan_count: 3, kept_count: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const scan = async (createdAt: Date, decision: 'kept' | 'skipped') =>
      (
        await db
          .insertInto('item_scan')
          .values({
            account_id: accountId,
            run_id: run.id,
            image_sha256: 'b'.repeat(64),
            image_count: 1,
            read: jsonb({}),
            call: 'your_call',
            confidence: 'low',
            basis: 'ai_estimate',
            call_detail: jsonb({}),
            decision,
            item_id: decision === 'kept' ? itemId : null,
            model: 'claude-haiku-5-5',
            ai_attempts: 1,
            cost_micros: 300,
            read_ms: 1400,
            created_at: createdAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const old = await scan(ago(RETENTION_DAYS.unkeptScans + 1), 'skipped');
    const recent = await scan(ago(RETENTION_DAYS.unkeptScans - 1), 'skipped');
    const kept = await scan(ago(RETENTION_DAYS.unkeptScans + 30), 'kept');

    for (const [key, days] of [
      ['old', RETENTION_DAYS.scanResearch + 1],
      ['fresh', 1],
    ] as const) {
      await db
        .insertInto('scan_research')
        .values({
          account_id: accountId,
          kind: 'item',
          key,
          research: jsonb({}),
          model: 'claude-haiku-5-5',
          cost_micros: 20_000,
          created_at: ago(days),
        })
        .execute();
    }

    const summary = await runDataRetention({ db, logger });
    expect(summary.unkeptScans).toBeGreaterThanOrEqual(1);
    const research = await db
      .selectFrom('scan_research')
      .select('key')
      .where('account_id', '=', accountId)
      .execute();
    expect(research).toEqual([{ key: 'fresh' }]);
    expect(await ids('item_scan', [old, recent, kept])).toEqual([recent, kept].sort());
    const counts = await db
      .selectFrom('sourcing_run')
      .select(['scan_count', 'kept_count'])
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(counts).toEqual({ scan_count: 3, kept_count: 1 });
  });

  it('deletes the data of a connection revoked 30 days ago that was never reconnected', async () => {
    const { accountId } = await account();
    const connection = async (status: 'revoked' | 'connected', since: Date) =>
      (
        await db
          .insertInto('marketplace_connection')
          .values({
            account_id: accountId,
            marketplace: 'ebay',
            mode: 'api',
            external_user_id: randomUUID(),
            display_name: 'closet_queen',
            status,
            token_ciphertext: status === 'revoked' ? null : Buffer.from('sealed'),
            last_error: 'You removed Listora’s access in your eBay account settings.',
            last_error_code: 'revoked_by_seller',
            last_error_at: since,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const longRevoked = await connection('revoked', ago(RETENTION_DAYS.revokedConnections + 1));
    const justRevoked = await connection('revoked', ago(RETENTION_DAYS.revokedConnections - 1));
    const failingButConnected = await connection(
      'connected',
      ago(RETENTION_DAYS.revokedConnections + 1),
    );

    const summary = await runDataRetention({ db, logger });
    expect(summary.revokedConnections).toBe(1);
    const left = await db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', accountId)
      .orderBy('id')
      .execute();
    expect(left.map((row) => row.id)).toEqual([justRevoked, failingButConnected].sort());
    const tombstone = await db
      .selectFrom('connection_deletion')
      .select(['reason', 'revocation', 'token_ciphertext'])
      .where('connection_id', '=', longRevoked)
      .executeTakeFirstOrThrow();
    // The marketplace revoked the grant itself; nothing is left to revoke.
    expect(tombstone).toEqual({ reason: 'revoked', revocation: 'none', token_ciphertext: null });
  });

  it('deletes expired connect attempts and old deletion records', async () => {
    const { accountId } = await account();
    const user = await db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: `${randomUUID()}@example.com` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const attempt = async (expiresAt: Date) =>
      (
        await db
          .insertInto('connection_authorization')
          .values({
            account_id: accountId,
            user_id: user.id,
            marketplace: 'ebay',
            state_sha256: Buffer.from(randomUUID().replaceAll('-', '').padEnd(64, '0'), 'hex'),
            expires_at: expiresAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const expired = await attempt(ago(2));
    const pending = await attempt(new Date(Date.now() + 600_000));
    const record = async (completedAt: Date) => {
      const id = randomUUID();
      await db
        .insertInto('deletion_record')
        .values({
          id,
          kind: 'account',
          reason: 'user_request',
          requested_at: completedAt,
          completed_at: completedAt,
        })
        .execute();
      return id;
    };
    const oldRecord = await record(ago(RETENTION_DAYS.deletionRecords + 1));
    const recentRecord = await record(ago(1));

    await runDataRetention({ db, logger });
    const attempts = await db
      .selectFrom('connection_authorization')
      .select('id')
      .where('id', 'in', [expired, pending])
      .execute();
    expect(attempts.map((row) => row.id)).toEqual([pending]);
    const records = await db
      .selectFrom('deletion_record')
      .select('id')
      .where('id', 'in', [oldRecord, recentRecord])
      .execute();
    expect(records.map((row) => row.id)).toEqual([recentRecord]);
  });

  it("clears buyers' names and tracking numbers once a sale is done, and offers' buyers once closed, only when turned on", async () => {
    const { accountId } = await account();
    const sale = async (
      status: 'confirmed' | 'shipped' | 'canceled' | 'returned',
      at: Partial<Record<'shipped_at' | 'canceled_at' | 'returned_at', Date>>,
    ) => {
      const { id } = await db
        .insertInto('sale')
        .values({
          account_id: accountId,
          marketplace: 'depop',
          sold_at: ago(200),
          detection_source: 'manual',
          status,
          ...at,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const tracking = `9400${randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`;
      await db
        .insertInto('sale_label')
        .values({
          account_id: accountId,
          sale_id: id,
          tracking_number: tracking,
          carrier: 'usps',
          source: 'marketplace',
          buyer_first_name: 'Jordan',
        })
        .execute();
      await db
        .insertInto('sale_pack')
        .values({
          account_id: accountId,
          sale_id: id,
          tracking_number: tracking,
          matched_by: 'label',
        })
        .execute();
      return id;
    };
    const days = RETENTION_DAYS.saleLabelBuyers;
    const longShipped = await sale('shipped', { shipped_at: ago(days + 1) });
    const longCanceled = await sale('canceled', { canceled_at: ago(days + 1) });
    const justShipped = await sale('shipped', { shipped_at: ago(days - 1) });
    // Shipped long ago, but returned since: the count starts again at the return.
    const returnedSince = await sale('returned', {
      shipped_at: ago(days + 30),
      returned_at: ago(days - 1),
    });
    // Never done, however old: it may still be a package to send.
    const open = await sale('confirmed', {});

    const { id: connectionId } = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'poshmark',
        mode: 'automation',
        status: 'connected',
        display_name: 'closet_queen',
        token_ciphertext: Buffer.from('sealed'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const offer = async (status: 'pending' | 'accepted' | 'closed', closedAt: Date | null) =>
      (
        await db
          .insertInto('marketplace_offer')
          .values({
            account_id: accountId,
            connection_id: connectionId,
            marketplace: 'poshmark',
            external_offer_id: randomUUID(),
            status,
            amount_cents: 2_000,
            buyer_name: 'thrift_fan_22',
            closed_at: closedAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const longClosed = await offer('accepted', ago(RETENTION_DAYS.offerBuyers + 1));
    const justClosed = await offer('closed', ago(RETENTION_DAYS.offerBuyers - 1));
    const pending = await offer('pending', null);

    // Off (the default): nothing of buyers is cleared; the run logs what would be.
    const lines: Record<string, unknown>[] = [];
    const recording = createLogger({
      service: 'retention-test',
      level: 'info',
      destination: {
        write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
      },
    });
    const off = await runDataRetention({ db, logger: recording });
    expect(off).toMatchObject({
      saleLabelBuyers: 0,
      packageTracking: 0,
      offerBuyers: 0,
      buyerDataWouldClear: { saleLabelBuyers: 2, packageTracking: 2, offerBuyers: 1 },
    });
    expect(lines.find((line) => line['buyerDataRetention'] === 'off')).toMatchObject({
      msg: 'buyer data retention is off: nothing of buyers was cleared',
      wouldClear: { saleLabelBuyers: 2, packageTracking: 2, offerBuyers: 1 },
    });
    const untouched = await db
      .selectFrom('sale_label')
      .select('buyer_first_name')
      .where('account_id', '=', accountId)
      .where('buyer_first_name', 'is', null)
      .execute();
    expect(untouched).toEqual([]);
    expect(
      await db
        .selectFrom('marketplace_offer')
        .select('id')
        .where('account_id', '=', accountId)
        .where('buyer_name', 'is', null)
        .execute(),
    ).toEqual([]);

    // On: they are cleared.
    const summary = await runDataRetention({ db, logger, buyerData: 'on' });
    expect(summary).toMatchObject({ saleLabelBuyers: 2, packageTracking: 2, offerBuyers: 1 });
    expect(summary.buyerDataWouldClear).toBeUndefined();
    const labels = await db
      .selectFrom('sale_label')
      .select(['sale_id', 'buyer_first_name', 'tracking_number', 'carrier', 'source'])
      .where('account_id', '=', accountId)
      .execute();
    const cleared = { buyer_first_name: null, tracking_number: null, carrier: null, source: null };
    for (const label of labels) {
      if ([longShipped, longCanceled].includes(label.sale_id)) {
        expect(label, label.sale_id).toMatchObject(cleared);
      } else {
        expect([justShipped, returnedSince, open]).toContain(label.sale_id);
        expect(label.buyer_first_name).toBe('Jordan');
        expect(label.tracking_number).not.toBeNull();
      }
    }
    const packs = await db
      .selectFrom('sale_pack')
      .select(['sale_id', 'tracking_number', 'matched_by'])
      .where('account_id', '=', accountId)
      .execute();
    // The package records stay: only their tracking numbers go.
    expect(packs).toHaveLength(5);
    expect(
      packs
        .filter((pack) => pack.tracking_number === null)
        .map((pack) => pack.sale_id)
        .sort(),
    ).toEqual([longShipped, longCanceled].sort());

    const offers = await db
      .selectFrom('marketplace_offer')
      .select(['id', 'buyer_name'])
      .where('account_id', '=', accountId)
      .execute();
    expect(Object.fromEntries(offers.map((row) => [row.id, row.buyer_name]))).toEqual({
      [longClosed]: null,
      [justClosed]: 'thrift_fan_22',
      [pending]: 'thrift_fan_22',
    });
    // Nothing is left to clear the next day.
    expect(await runDataRetention({ db, logger, buyerData: 'on' })).toMatchObject({
      saleLabelBuyers: 0,
      packageTracking: 0,
      offerBuyers: 0,
    });
  });

  it("counts an imported sale's 60 days from the marketplace's dates, not from the import", async () => {
    const { accountId } = await account();
    const days = RETENTION_DAYS.saleLabelBuyers;
    /** Imports a sale from the sales history: recorded, and in the same transaction, done. */
    const imported = async (
      soldAt: Date,
      options: { shipBy?: Date; done?: 'mark_shipped' | 'cancel' | null } = {},
    ) => {
      const id = await inTransaction(db, async (trx) => {
        const { id } = await trx
          .insertInto('sale')
          .values({
            account_id: accountId,
            marketplace: 'depop',
            external_order_id: randomUUID(),
            sold_at: soldAt,
            ship_by: options.shipBy ?? null,
            detection_source: 'history',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const done = options.done === undefined ? 'mark_shipped' : options.done;
        if (done !== null) {
          await changeSale(trx, { accountId, saleId: id, action: done, userId: null });
        }
        return id;
      });
      await db
        .insertInto('sale_label')
        .values({
          account_id: accountId,
          sale_id: id,
          tracking_number: `9400${randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`,
          carrier: 'usps',
          source: 'marketplace',
          buyer_first_name: 'Jordan',
        })
        .execute();
      return id;
    };
    // Shipped or canceled on the marketplace long before the import: the count started then.
    const soldLongAgo = await imported(ago(days + 5));
    const canceledLongAgo = await imported(ago(days + 5), { done: 'cancel' });
    // Sold within the 60 days: kept, though the import is today.
    const soldRecently = await imported(ago(days - 5));
    // Sold long ago but due to ship only within the 60 days: counted from its ship-by date.
    const shipByRecently = await imported(ago(days + 30), { shipBy: ago(days - 1) });
    // Found waiting to ship, and shipped since: Listora saw it ship, so the count starts then.
    const shippedSince = await imported(ago(days + 5), { done: null });
    await changeSale(db, { accountId, saleId: shippedSince, action: 'mark_shipped', userId: null });
    // Shipped before the import and returned since: the count starts again at the return.
    const returnedSince = await imported(ago(days + 5));
    await changeSale(db, {
      accountId,
      saleId: returnedSince,
      action: 'record_return',
      userId: null,
    });

    const off = await runDataRetention({ db, logger });
    expect(off.buyerDataWouldClear).toMatchObject({ saleLabelBuyers: 2 });
    await runDataRetention({ db, logger, buyerData: 'on' });
    const labels = await db
      .selectFrom('sale_label')
      .select(['sale_id', 'buyer_first_name', 'tracking_number'])
      .where('account_id', '=', accountId)
      .execute();
    const kept = Object.fromEntries(
      labels.map((label) => [label.sale_id, label.buyer_first_name !== null]),
    );
    expect(kept).toEqual({
      [soldLongAgo]: false,
      [canceledLongAgo]: false,
      [soldRecently]: true,
      [shipByRecently]: true,
      [shippedSince]: true,
      [returnedSince]: true,
    });
    // What the seller sees of the sale is unchanged: shipped when Listora recorded it shipped.
    const sale = await db
      .selectFrom('sale')
      .select(['shipped_at', 'created_at'])
      .where('id', '=', soldLongAgo)
      .executeTakeFirstOrThrow();
    expect(sale.shipped_at).toEqual(sale.created_at);
  });

  it('works off a backlog in batches, a bounded amount per run', async () => {
    const seeded = await account();
    const settled = await operation(seeded, 'failed', ago(400));
    const events: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      events.push(await event(seeded.accountId, settled, ago(400)));
    }
    // Earlier tests' rows are gone already, so this run sees only these five.
    const first = await runDataRetention({ db, logger, batchSize: 2, maxBatches: 2 });
    expect(first.operationEvents).toBe(4);
    expect(await ids('operation_event', events)).toHaveLength(1);
    const second = await runDataRetention({ db, logger, batchSize: 2, maxBatches: 2 });
    expect(second.operationEvents).toBe(1);
    expect(await ids('operation_event', events)).toEqual([]);
  });
});
