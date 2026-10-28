/**
 * The activity timeline on real Postgres: an item's, an operation's, a sale's, and a marketplace's
 * timelines are read from the records the server, the runner, and the phone keep (operation
 * steps, browser sessions with their steps, sale checks, orders, sales, delists, tasks, item
 * changes), newest first, within one account, and the sale explanation says which check saw a
 * sale and what each delist it started did.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createInventoryItem, jsonb, type Db } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';

import { loadActivity } from './load.ts';
import { loadSaleExplanation } from './sale.ts';

const MINUTE = 60_000;
const START = new Date('2026-10-26T15:00:00Z');
const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);

describe('activity timeline (real Postgres)', () => {
  let database: MigratedDatabase;
  let db: Db;
  let accountId: string;
  let seeded: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    database = await createMigratedDatabase('activity');
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    accountId = await insertAccount(db);
    seeded = await seed(accountId);
  });

  /**
   * One item sold on Mercari, which a phone sale check saw at 15:10; its Depop listing's delist
   * failed after the phone's browser session stopped at a step, and Poshmark's waits for the
   * seller.
   */
  async function seed(account: string) {
    const item = await createInventoryItem(db, account, { title: 'Trucker jacket' });
    const connection = async (marketplace: 'mercari' | 'depop' | 'poshmark') =>
      (
        await db
          .insertInto('marketplace_connection')
          .values({
            account_id: account,
            marketplace,
            mode: 'automation',
            status: 'connected',
            token_ciphertext: Buffer.from('sealed'),
            runs_on: 'phone',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const mercari = await connection('mercari');
    const depop = await connection('depop');
    const listing = async (
      marketplace: 'mercari' | 'depop' | 'poshmark',
      connectionId: string | null,
    ) =>
      (
        await db
          .insertInto('marketplace_listing')
          .values({
            account_id: account,
            item_id: item.id,
            marketplace,
            connection_id: connectionId,
            external_listing_id: `${marketplace}-1`,
            status: 'active',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const mercariListing = await listing('mercari', mercari);
    const depopListing = await listing('depop', depop);
    const poshmarkListing = await listing('poshmark', null);

    await db
      .insertInto('audit_log')
      .values({
        account_id: account,
        item_id: item.id,
        actor_kind: 'user',
        action: 'item.created',
        changes: jsonb({}),
        created_at: at(0),
      })
      .execute();

    const check = await db
      .insertInto('sale_check_run')
      .values({
        account_id: account,
        connection_id: mercari,
        marketplace: 'mercari',
        kind: 'scheduled',
        reason: 'scheduled',
        host: 'phone',
        started_at: at(10),
        finished_at: new Date(at(10).getTime() + 8_400),
        outcome: 'succeeded',
        orders_seen: 3,
        items_seen: 3,
        new_orders: 1,
        orders: jsonb([
          {
            orderId: 'm-order-9',
            soldAt: at(5).toISOString(),
            items: [{ listingId: 'mercari-1', title: 'Trucker jacket', priceCents: 4500 }],
          },
        ]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const failedCheck = await db
      .insertInto('sale_check_run')
      .values({
        account_id: account,
        connection_id: depop,
        marketplace: 'depop',
        kind: 'scheduled',
        reason: 'retry',
        host: 'phone',
        started_at: at(8),
        finished_at: at(8),
        outcome: 'failed',
        error_code: 'element_missing',
        error_message: "Depop's sold items page has changed, so Listora couldn't read it.",
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const event = await db
      .insertInto('inbound_event')
      .values({
        account_id: account,
        source: 'poll',
        marketplace: 'mercari',
        provider_event_id: 'order:m-order-9',
        payload: jsonb({ externalOrderId: 'm-order-9', saleCheckRunId: check.id }),
        processed_at: at(11),
        result: 'processed',
        created_at: at(10.5),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const sale = await db
      .insertInto('sale')
      .values({
        account_id: account,
        marketplace: 'mercari',
        external_order_id: 'm-order-9',
        sold_at: at(5),
        detection_source: 'poll',
        inbound_event_id: event.id,
        sale_check_run_id: check.id,
        created_at: at(11),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_item')
      .values({
        account_id: account,
        sale_id: sale.id,
        marketplace: 'mercari',
        item_id: item.id,
        listing_id: mercariListing,
        sale_price_cents: 4500,
      })
      .execute();
    const run = await db
      .insertInto('delist_run')
      .values({ account_id: account, sale_id: sale.id, item_id: item.id, created_at: at(11.05) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { rows } = await sql<{ id: string }>`
      insert into marketplace_operation
        (account_id, listing_id, kind, idempotency_key, desired, status, attempts, origin,
         delist_run_id, error_code, error_message, created_at, updated_at)
      values (${account}, ${depopListing}, 'end', ${randomUUID()}, '{"status":"ended"}', 'failed',
        3, 'auto_delist', ${run.id}, 'listing_not_found', 'Depop no longer shows the listing.',
        ${at(11.1)}, ${at(14)})
      returning id
    `.execute(db);
    const operationId = rows[0]?.id ?? '';
    for (const [minutes, from, to, attempt, detail] of [
      [11.1, null, 'queued', 0, {}],
      [12, 'queued', 'running', 1, { mode: 'automation' }],
      [14, 'running', 'failed', 1, { error: { message: 'Depop no longer shows the listing.' } }],
    ] as const) {
      await db
        .insertInto('operation_event')
        .values({
          account_id: account,
          operation_id: operationId,
          from_status: from,
          to_status: to,
          attempt,
          error_code: to === 'failed' ? 'listing_not_found' : null,
          detail: jsonb(detail),
          created_at: at(minutes),
        })
        .execute();
    }
    const session = await db
      .insertInto('automation_run')
      .values({
        account_id: account,
        connection_id: depop,
        marketplace: 'depop',
        purpose: 'operation',
        script: 'end',
        operation_id: operationId,
        host: 'phone',
        started_at: at(12.05),
        finished_at: new Date(at(12.05).getTime() + 12_340),
        outcome: 'failed',
        failed_step: 'find Delete listing',
        error_code: 'element_missing',
        steps: jsonb([
          { name: 'open the listing', ms: 1_840 },
          { name: 'find Delete listing', ms: 10_500 },
        ]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A sign-in check: an account timeline shows it, an item's does not.
    await db
      .insertInto('automation_run')
      .values({
        account_id: account,
        connection_id: mercari,
        marketplace: 'mercari',
        purpose: 'health',
        script: 'health check',
        host: 'phone',
        started_at: at(1),
        finished_at: at(1),
        outcome: 'succeeded',
      })
      .execute();
    const task = await db
      .insertInto('user_task')
      .values({
        account_id: account,
        kind: 'delist_manually',
        item_id: item.id,
        listing_id: poshmarkListing,
        delist_run_id: run.id,
        urgency: 'urgent',
        created_at: at(11.15),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      itemId: item.id,
      saleId: sale.id,
      operationId,
      sessionId: session.id,
      checkId: check.id,
      failedCheckId: failedCheck.id,
      taskId: task.id,
    };
  }

  it("tells an item's story newest first, from the server's, the phone's, and the checks' records", async () => {
    const entries = await loadActivity(db, { accountId, itemId: seeded.itemId, limit: 50 });
    expect(entries.map((entry) => [entry.kind, entry.title])).toEqual([
      ['operation', 'Delist on Depop after the sale'],
      ['browser_session', 'Your iPhone ended the listing on Depop'],
      ['operation', 'Delist on Depop after the sale'],
      ['task', 'Waiting for you: delist it on Poshmark'],
      ['operation', 'Delist on Depop after the sale'],
      ['delist', 'Delisting it everywhere else'],
      ['sale', 'Sold on Mercari for $45.00 (order m-order-9)'],
      ['sale_check', 'Checked Mercari for sales'],
      ['item', 'Item created'],
    ]);
    const failed = entries[0];
    expect(failed).toMatchObject({
      source: 'listora',
      outcome: 'failed',
      marketplace: 'depop',
      detail: 'Depop no longer shows the listing.',
      operationId: seeded.operationId,
      error: { code: 'listing_not_found', message: 'Depop no longer shows the listing.' },
    });
    expect(entries[1]).toMatchObject({
      source: 'iphone',
      outcome: 'failed',
      durationMs: 12_340,
      detail: "Stopped at “find Delete listing”: the page wasn't what Listora expected.",
      steps: [
        { name: 'open the listing', durationMs: 1_840 },
        { name: 'find Delete listing', durationMs: 10_500 },
      ],
      reference: { runId: seeded.sessionId, saleCheckId: null, screenshot: false },
    });
    expect(entries.find((entry) => entry.kind === 'sale')).toMatchObject({
      source: 'marketplace',
      detail: 'Listora found it on Mercari.',
      reference: { saleCheckId: seeded.checkId },
    });
    expect(entries.find((entry) => entry.kind === 'sale_check')).toMatchObject({
      source: 'iphone',
      outcome: 'succeeded',
      detail: 'Saw 3 sold orders on your iPhone, 1 new.',
      durationMs: 8_400,
    });
    // Only this item's, and only in its account.
    expect(entries.map((entry) => entry.id)).not.toContain(`sale_check:${seeded.failedCheckId}`);
    const other = await insertAccount(db);
    expect(await loadActivity(db, { accountId: other, itemId: seeded.itemId, limit: 50 })).toEqual(
      [],
    );
  });

  it('pages by time and limits', async () => {
    const all = await loadActivity(db, { accountId, itemId: seeded.itemId, limit: 50 });
    const first = await loadActivity(db, { accountId, itemId: seeded.itemId, limit: 3 });
    expect(first.map((entry) => entry.id)).toEqual(all.slice(0, 3).map((entry) => entry.id));
    const before = await loadActivity(db, {
      accountId,
      itemId: seeded.itemId,
      to: at(11),
      limit: 50,
    });
    expect(before.map((entry) => entry.kind)).toEqual(['sale_check', 'item']);
    const window = await loadActivity(db, {
      accountId,
      itemId: seeded.itemId,
      from: at(12),
      to: at(13),
      limit: 50,
    });
    expect(window.map((entry) => entry.kind)).toEqual(['browser_session', 'operation']);
  });

  it("tells one marketplace action's story: its steps, its browser sessions, its tasks", async () => {
    const entries = await loadActivity(db, {
      accountId,
      operationId: seeded.operationId,
      limit: 50,
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      'operation',
      'browser_session',
      'operation',
      'operation',
    ]);
    expect(entries.every((entry) => entry.operationId === seeded.operationId)).toBe(true);
  });

  it("searches one marketplace's activity in an account: its checks, sessions, and orders", async () => {
    const depop = await loadActivity(db, { accountId, marketplace: 'depop', limit: 50 });
    expect(depop.map((entry) => entry.kind)).toEqual([
      'operation',
      'browser_session',
      'operation',
      'operation',
      'sale_check',
    ]);
    expect(depop.at(-1)).toMatchObject({
      title: "Couldn't check Depop for sales",
      outcome: 'failed',
      error: { code: 'element_missing' },
    });
    const mercari = await loadActivity(db, { accountId, marketplace: 'mercari', limit: 50 });
    expect(mercari.map((entry) => entry.kind)).toEqual([
      'sale',
      'order',
      'sale_check',
      'browser_session',
    ]);
    expect(mercari[1]).toMatchObject({
      title: 'Mercari order m-order-9 seen by a sale check',
      detail: 'Recorded as a sale.',
    });
  });

  it('explains a sale: which check saw it, when, and what each delist did', async () => {
    const explanation = await loadSaleExplanation(db, { accountId, saleId: seeded.saleId });
    expect(explanation).toMatchObject({
      saleId: seeded.saleId,
      marketplace: 'mercari',
      externalOrderId: 'm-order-9',
      soldAt: at(5),
      reportedAt: at(10.5),
      recordedAt: at(11),
      detectionSource: 'poll',
      detection: 'Listora found it on Mercari.',
      check: {
        id: seeded.checkId,
        kind: 'scheduled',
        host: 'phone',
        startedAt: at(10),
        ordersSeen: 3,
        newOrders: 1,
      },
      delists: [
        {
          marketplace: 'depop',
          operationId: seeded.operationId,
          status: 'failed',
          result: 'Delist failed: Depop no longer shows the listing.',
          attempts: 3,
          error: { code: 'listing_not_found' },
          startedAt: at(11.1),
          settledAt: at(14),
        },
        {
          marketplace: 'poshmark',
          taskId: seeded.taskId,
          status: 'open',
          result: 'Waiting for you to delist it on Poshmark.',
          settledAt: null,
        },
      ],
    });
    expect(explanation?.entries.map((entry) => entry.kind)).toEqual([
      'operation',
      'browser_session',
      'operation',
      'task',
      'operation',
      'delist',
      'sale',
      'order',
      'sale_check',
    ]);
    expect(
      await loadSaleExplanation(db, { accountId: await insertAccount(db), saleId: seeded.saleId }),
    ).toBe(undefined);
  });
});
