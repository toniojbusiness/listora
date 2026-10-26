import { randomUUID } from 'node:crypto';

import { createInventoryItem, jsonb, type Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
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

  async function ids(table: 'operation_event' | 'inbound_event' | 'ai_usage_event', of: string[]) {
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
