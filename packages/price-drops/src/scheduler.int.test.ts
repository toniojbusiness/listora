/**
 * The price drop schedule against a real Postgres (docs/features/price-drops.md): which drops
 * run, at what price, how fast, and every case where none may.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, jsonb, type Db, type Marketplace } from '@listora/db';
import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  SELLER_FEATURES,
  useMarketplaceFeatures,
  type MarketplaceAdapter,
  type MarketplaceCapabilities,
} from '@listora/marketplaces';

import { loadDropDefaults } from './defaults.ts';
import { loadDropFacts, planDrops } from './plan.ts';
import { PRICE_DROP_PACE, runPriceDrops, type RunLimits } from './scheduler.ts';
import { createDropRule, listDropRules, updateDropRule, type DropRuleTarget } from './store.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-31T15:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LIMITS: RunLimits = { runsPerHour: 30, runsPerDay: 200 };
const TERMS = { percent: 10, afterDays: 21, floorCents: 2500 };

/** Only the capabilities matter to the schedule: an automation adapter that changes prices. */
function adapterFor(
  marketplace: Marketplace,
  price: 'automation' | 'assisted',
): MarketplaceAdapter {
  const capabilities = {
    connect: 'session',
    verifyRead: 'automation',
    updatePrice: price,
  } as unknown as MarketplaceCapabilities;
  return { id: marketplace, capabilities: () => capabilities } as unknown as MarketplaceAdapter;
}

describe('the price drop schedule', () => {
  let database: MigratedDatabase;
  let db: Db;
  let sequence = 0;

  beforeAll(async () => {
    database = await createMigratedDatabase('price_drops', { jobQueue: true });
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  async function seller(marketplace: Marketplace = 'depop', readOnly = false) {
    const accountId = await insertAccount(db, 'PD');
    const connection = await db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace,
        mode: 'automation',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed'),
        read_only: readOnly,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { accountId, connectionId: connection.id };
  }

  async function listing(
    accountId: string,
    connectionId: string,
    listedAt: Date,
    options: {
      brand?: string;
      priceCents?: number;
      floorCents?: number;
      marketplace?: Marketplace;
    } = {},
  ): Promise<{ itemId: string; listingId: string }> {
    sequence += 1;
    const item = await createInventoryItem(db, accountId, {
      title: `Fleece ${String(sequence)}`,
      brand: options.brand ?? 'Patagonia',
      status: 'listed',
      floor_price_cents: options.floorCents ?? null,
    });
    const row = await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: options.marketplace ?? 'depop',
        status: 'active',
        connection_id: connectionId,
        external_listing_id: `ext-${String(sequence)}`,
        listed_at: listedAt,
        price_cents: options.priceCents ?? 4000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { itemId: item.id, listingId: row.id };
  }

  /** A rule that took effect long ago, so its notice is over. */
  async function rule(
    accountId: string,
    target: DropRuleTarget = { scope: 'brand', brand: 'Patagonia' },
    terms = TERMS,
  ) {
    const made = await createDropRule(db, accountId, target, terms);
    await db
      .updateTable('price_drop_rule')
      .set({ armed_at: ago(30 * DAY) })
      .where('id', '=', made.id)
      .execute();
    return made.id;
  }

  async function operation(
    accountId: string,
    listingId: string,
    status: 'succeeded' | 'failed' | 'queued' | 'canceled',
    createdAt: Date,
    extra: { origin?: 'user' | 'reprice_rule'; ruleId?: string; key?: string } = {},
  ) {
    sequence += 1;
    await db
      .insertInto('marketplace_operation')
      .values({
        account_id: accountId,
        listing_id: listingId,
        kind: 'price',
        idempotency_key: extra.key ?? `op-${String(sequence)}`,
        desired: jsonb({ priceCents: 3600, currency: 'USD' }),
        status,
        ...(status === 'succeeded' ? { success_evidence: 'read_back' as const } : {}),
        ...(status === 'failed' ? { error_code: 'x', error_message: 'Failed.' } : {}),
        origin: extra.origin ?? 'user',
        price_drop_rule_id: extra.ruleId ?? null,
        created_at: createdAt,
      })
      .execute();
  }

  async function dropsOf(accountId: string) {
    return db
      .selectFrom('marketplace_operation')
      .select(['listing_id', 'kind', 'origin', 'desired', 'status', 'price_drop_rule_id'])
      .where('account_id', '=', accountId)
      .where('origin', '=', 'reprice_rule')
      .where('status', '=', 'queued')
      .execute();
  }

  /** The drops the schedule queued for the account (each key names its unsold period). */
  async function sent(accountId: string): Promise<number> {
    const row = await db
      .selectFrom('marketplace_operation')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('account_id', '=', accountId)
      .where('idempotency_key', 'like', 'price_drop:%')
      .executeTakeFirstOrThrow();
    return row.count;
  }

  const run = (at: Date = NOW, price: 'automation' | 'assisted' = 'automation') =>
    runPriceDrops({
      db,
      adapters: (marketplace) => adapterFor(marketplace, price),
      limits: () => LIMITS,
      logger: { info: () => undefined },
      now: () => at,
    });

  async function plans(accountId: string, at: Date = NOW) {
    const facts = await loadDropFacts(db, accountId);
    return planDrops(facts, await listDropRules(db, accountId), SELLER_FEATURES, at);
  }

  it('drops the price of a listing unsold past the days, as a price change read back, with its history', async () => {
    const { accountId, connectionId } = await seller();
    const ruleId = await rule(accountId);
    const due = await listing(accountId, connectionId, ago(30 * DAY));

    await run();
    expect(await sent(accountId)).toBe(1);
    expect(await dropsOf(accountId)).toEqual([
      {
        listing_id: due.listingId,
        kind: 'price',
        origin: 'reprice_rule',
        desired: { priceCents: 3600, currency: 'USD' },
        status: 'queued',
        price_drop_rule_id: ruleId,
      },
    ]);
    const row = await db
      .selectFrom('marketplace_listing')
      .select(['price_cents', 'desired_version'])
      .where('id', '=', due.listingId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ price_cents: 3600, desired_version: 1 });
    const audit = await db
      .selectFrom('audit_log')
      .select(['actor_kind', 'action', 'changes'])
      .where('account_id', '=', accountId)
      .where('item_id', '=', due.itemId)
      .where('action', '=', 'listing.price_drop_requested')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_kind: 'system',
      changes: { listingId: due.listingId, ruleId, priceCents: { from: 4000, to: 3600 } },
    });
  });

  it('shows every planned drop first, waiting out the day of notice after a rule is made', async () => {
    const { accountId, connectionId } = await seller();
    const made = await createDropRule(db, accountId, { scope: 'brand', brand: 'Patagonia' }, TERMS);
    const due = await listing(accountId, connectionId, ago(60 * DAY));
    const later = await listing(accountId, connectionId, ago(10 * DAY));

    const planned = await plans(accountId, made.armedAt);
    expect(planned.map(({ fact, plan }) => [fact.listingId, plan])).toEqual([
      [
        due.listingId,
        {
          state: 'scheduled',
          at: new Date(made.armedAt.getTime() + DAY),
          priceCents: 3600,
        },
      ],
      [
        later.listingId,
        { state: 'scheduled', at: new Date(ago(10 * DAY).getTime() + 21 * DAY), priceCents: 3600 },
      ],
    ]);
    await run(made.armedAt);
    expect(await sent(accountId)).toBe(0);
    await run(new Date(made.armedAt.getTime() + DAY + HOUR));
    expect(await sent(accountId)).toBe(1);
    expect((await dropsOf(accountId)).map((drop) => drop.listing_id)).toEqual([due.listingId]);
  });

  it('never drops below the floor or the item’s own lowest price', async () => {
    const { accountId, connectionId } = await seller();
    await rule(accountId, { scope: 'brand', brand: 'Patagonia' }, { ...TERMS, percent: 50 });
    const floored = await listing(accountId, connectionId, ago(30 * DAY), { priceCents: 2500 });
    const ownFloor = await listing(accountId, connectionId, ago(29 * DAY), {
      priceCents: 4000,
      floorCents: 3500,
    });

    const planned = await plans(accountId);
    expect(planned.map(({ fact, plan }) => [fact.listingId, plan])).toEqual([
      [ownFloor.listingId, { state: 'scheduled', at: NOW, priceCents: 3500 }],
      [floored.listingId, { state: 'at_floor' }],
    ]);
    await run();
    expect(await dropsOf(accountId)).toMatchObject([
      { listing_id: ownFloor.listingId, desired: { priceCents: 3500 } },
    ]);
  });

  it("lets an item's own rule win over its brand's, also when it is off", async () => {
    const { accountId, connectionId } = await seller();
    await rule(accountId);
    const own = await listing(accountId, connectionId, ago(30 * DAY));
    const left = await listing(accountId, connectionId, ago(40 * DAY));
    await rule(accountId, { scope: 'item', itemId: own.itemId }, { ...TERMS, percent: 20 });
    const off = await rule(accountId, { scope: 'item', itemId: left.itemId });
    await db.updateTable('price_drop_rule').set({ enabled: false }).where('id', '=', off).execute();
    const other = await listing(accountId, connectionId, ago(30 * DAY), { brand: 'Levi’s' });

    const planned = await plans(accountId);
    expect(planned.map(({ fact, plan }) => [fact.listingId, plan])).toEqual([
      [own.listingId, { state: 'scheduled', at: NOW, priceCents: 3200 }],
    ]);
    await run();
    expect((await dropsOf(accountId)).map((drop) => drop.listing_id)).toEqual([own.listingId]);
    expect(planned.some(({ fact }) => fact.listingId === other.listingId)).toBe(false);
  });

  it('starts the days again after any price change, and after a drop', async () => {
    const { accountId, connectionId } = await seller();
    const ruleId = await rule(accountId);
    const changed = await listing(accountId, connectionId, ago(60 * DAY));
    await operation(accountId, changed.listingId, 'succeeded', ago(5 * DAY));
    const dropped = await listing(accountId, connectionId, ago(60 * DAY));
    await operation(accountId, dropped.listingId, 'succeeded', ago(22 * DAY), {
      origin: 'reprice_rule',
      ruleId,
    });

    const planned = await plans(accountId);
    expect(planned.map(({ fact, plan }) => [fact.listingId, plan])).toEqual([
      [dropped.listingId, { state: 'scheduled', at: NOW, priceCents: 3600 }],
      [changed.listingId, { state: 'scheduled', at: ago(5 * DAY - 21 * DAY), priceCents: 3600 }],
    ]);
  });

  it('runs no drop after a failed price change, nor on a busy listing', async () => {
    const { accountId, connectionId } = await seller();
    await rule(accountId);
    const failed = await listing(accountId, connectionId, ago(30 * DAY));
    await operation(accountId, failed.listingId, 'failed', ago(1 * DAY));
    const busy = await listing(accountId, connectionId, ago(30 * DAY));
    await operation(accountId, busy.listingId, 'queued', ago(1 * HOUR));

    const planned = await plans(accountId);
    expect(planned.find(({ fact }) => fact.listingId === failed.listingId)?.plan.state).toBe(
      'last_failed',
    );
    await run();
    expect(await sent(accountId)).toBe(0);
  });

  it('never sends a drop the seller canceled again in the same unsold period', async () => {
    const { accountId, connectionId } = await seller();
    const ruleId = await rule(accountId);
    const canceled = await listing(accountId, connectionId, ago(30 * DAY));
    await operation(accountId, canceled.listingId, 'canceled', ago(1 * DAY), {
      origin: 'reprice_rule',
      ruleId,
      key: `price_drop:${canceled.listingId}:${String(ago(30 * DAY).getTime())}`,
    });
    await run();
    expect(await sent(accountId)).toBe(1);
  });

  it('touches no read-only shop, no rule that is off, and no assisted marketplace', async () => {
    const readOnly = await seller('depop', true);
    await rule(readOnly.accountId);
    await listing(readOnly.accountId, readOnly.connectionId, ago(30 * DAY));
    expect((await plans(readOnly.accountId)).map(({ plan }) => plan.state)).toEqual([
      'unavailable',
    ]);

    const off = await seller();
    const offRule = await rule(off.accountId);
    await listing(off.accountId, off.connectionId, ago(30 * DAY));
    await updateDropRule(db, off.accountId, offRule, { ...TERMS, enabled: false });
    expect(await plans(off.accountId)).toEqual([]);

    const assisted = await seller();
    await rule(assisted.accountId);
    await listing(assisted.accountId, assisted.connectionId, ago(30 * DAY));

    await run(NOW, 'assisted');
    expect(await dropsOf(readOnly.accountId)).toEqual([]);
    expect(await dropsOf(off.accountId)).toEqual([]);
    expect(await dropsOf(assisted.accountId)).toEqual([]);
  });

  it('paces drops: one at a time, minutes apart, and at most the daily cap', async () => {
    const { accountId, connectionId } = await seller();
    await rule(accountId);
    for (let index = 0; index < 4; index += 1) {
      await listing(accountId, connectionId, ago((30 + index) * DAY));
    }
    await run();
    expect(await sent(accountId)).toBe(1);
    // The first is unfinished: nothing more.
    await run();
    expect(await sent(accountId)).toBe(1);
    // It went through, sent at the schedule's now (the database stamps its own clock).
    await sql`update marketplace_operation
      set status = 'succeeded', success_evidence = 'read_back', created_at = ${NOW}
      where account_id = ${accountId}`.execute(db);
    // Finished, but within the gap.
    await run(new Date(NOW.getTime() + 5 * 60_000));
    expect(await sent(accountId)).toBe(1);
    await run(new Date(NOW.getTime() + PRICE_DROP_PACE.minGapMinutes * 60_000 + 1));
    expect(await sent(accountId)).toBe(2);

    // A full day's cap of drops on the connection stops the rest until a day has passed.
    const capped = await seller();
    const cappedRule = await rule(capped.accountId);
    const waiting = await listing(capped.accountId, capped.connectionId, ago(40 * DAY));
    for (let index = 0; index < PRICE_DROP_PACE.perConnectionPerDay; index += 1) {
      const done = await listing(capped.accountId, capped.connectionId, ago(1 * DAY), {
        brand: 'Other',
      });
      await operation(
        capped.accountId,
        done.listingId,
        'succeeded',
        ago(20 * HOUR - index * HOUR),
        {
          origin: 'reprice_rule',
          ruleId: cappedRule,
        },
      );
    }
    await run();
    expect(await sent(capped.accountId)).toBe(0);
    await run(new Date(NOW.getTime() + 21 * HOUR));
    expect(await sent(capped.accountId)).toBe(1);
    expect((await dropsOf(capped.accountId)).map((drop) => drop.listing_id)).toEqual([
      waiting.listingId,
    ]);
  });

  it('runs only where price drops passed live, or in Test mode', async () => {
    useMarketplaceFeatures('verified');
    try {
      // Depop passed live (verified-features.md): a seller's drop runs there.
      const depop = await seller();
      await rule(depop.accountId);
      await listing(depop.accountId, depop.connectionId, ago(30 * DAY));
      await run();
      expect(await sent(depop.accountId)).toBe(1);

      // Mercari has not: its listing is not even planned, and nothing is sent.
      const { accountId, connectionId } = await seller('mercari');
      await rule(accountId);
      await listing(accountId, connectionId, ago(30 * DAY), { marketplace: 'mercari' });
      expect(await plans(accountId)).toEqual([]);
      await run();
      expect(await sent(accountId)).toBe(0);

      await db
        .updateTable('account')
        .set({ test_mode: true })
        .where('id', '=', accountId)
        .execute();
      await run();
      expect(await sent(accountId)).toBe(1);
    } finally {
      useMarketplaceFeatures('all');
    }
  });
});

describe('the defaults from days to sell', () => {
  let database: MigratedDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createMigratedDatabase('price_drop_defaults');
    db = database.db;
  });

  afterAll(async () => {
    await database.close();
  });

  async function sold(accountId: string, brand: string, days: number, status = 'confirmed') {
    const item = await createInventoryItem(db, accountId, { title: brand, brand, status: 'sold' });
    await sql`update inventory_item set created_at = ${ago(days * DAY + 40 * DAY)}
      where id = ${item.id}`.execute(db);
    await db
      .insertInto('marketplace_listing')
      .values({
        account_id: accountId,
        item_id: item.id,
        marketplace: 'depop',
        status: 'sold',
        listed_at: ago(days * DAY + 10 * DAY),
      })
      .execute();
    const sale = await db
      .insertInto('sale')
      .values({
        account_id: accountId,
        marketplace: 'depop',
        external_order_id: `order-${item.id}`,
        detection_source: 'manual',
        status: status as 'confirmed',
        ...(status === 'canceled' ? { canceled_at: ago(9 * DAY) } : {}),
        sold_at: ago(10 * DAY),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('sale_item')
      .values({
        account_id: accountId,
        sale_id: sale.id,
        marketplace: 'depop',
        item_id: item.id,
        sale_price_cents: 3000,
      })
      .execute();
  }

  it("takes the brand's median days, else all of them, else 21; a canceled sale counts nowhere", async () => {
    const accountId = await insertAccount(db, 'PDD');
    expect(await loadDropDefaults(db, accountId, 'Patagonia')).toEqual({
      percent: 10,
      afterDays: 21,
    });
    await sold(accountId, 'Patagonia', 12);
    await sold(accountId, 'Patagonia', 16);
    await sold(accountId, 'Levi’s', 30);
    await sold(accountId, 'Levi’s', 30, 'canceled');
    expect(await loadDropDefaults(db, accountId, 'Patagonia')).toEqual({
      percent: 10,
      afterDays: 16,
      basis: { sales: 3, medianDays: 16 },
    });
    await sold(accountId, 'patagonia', 20);
    expect(await loadDropDefaults(db, accountId, 'Patagonia')).toEqual({
      percent: 10,
      afterDays: 16,
      basis: { sales: 3, medianDays: 16, brand: 'Patagonia' },
    });
  });
});
