import { jsonb, type Marketplace } from '@listora/db';
import { sql } from 'kysely';
import { useMarketplaceFeatures } from '@listora/marketplaces';
import { estimateFeesCents, feeTableFor, NO_SOLD_DATA_MESSAGE } from '@listora/pricing';
import { OWN_HISTORY_WINDOW_DAYS, SOURCING_KIT_VERSION } from '@listora/sourcing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import { payoutFees } from './fees.ts';
import type { Tenant } from '../tenancy.ts';

// Invented sellers and sales; no real shop's data.
const OWNER = 'sourcing.owner@example.com';
const OTHER = 'sourcing.other@example.com';
const LEGGINGS = 'clothing/bottoms/leggings';
const DAY_MS = 24 * 60 * 60 * 1000;
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

describe('own sales for sourcing (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let otherToken: string;
  let other: Tenant;

  beforeAll(async () => {
    api = await createTestApi('sourcing');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    otherToken = await api.signIn(OTHER);
    other = await api.tenantOf(OTHER);
  });

  afterEach(async () => {
    useMarketplaceFeatures('all');
    for (const account of [tenant, other]) {
      await api.db
        .updateTable('account')
        .set({ test_mode: false })
        .where('id', '=', account.accountId)
        .execute();
    }
  });

  afterAll(async () => {
    await api.close();
  });

  const createItem = async (details: Record<string, unknown>, as = token) => {
    const response = await api.call('createItem', { token: as, body: { details } });
    expect(response.status).toBe(201);
    return response.body;
  };

  /** A sold item of `owner`: a one-item sale on `marketplace`, `daysAgo` days back. */
  const sell = async (
    marketplace: Marketplace,
    details: Record<string, unknown>,
    salePriceCents: number,
    options: { owner?: Tenant; as?: string; daysAgo?: number; status?: 'canceled' } = {},
  ) => {
    const owner = options.owner ?? tenant;
    const item = await createItem(details, options.as ?? token);
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: owner.accountId,
        marketplace,
        sold_at: new Date(api.clock.now - (options.daysAgo ?? 3) * DAY_MS),
        detection_source: 'history',
        ...(options.status ? { status: options.status, canceled_at: new Date() } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: owner.accountId,
        sale_id: sale.id,
        marketplace,
        item_id: item.id,
        sale_price_cents: salePriceCents,
      })
      .execute();
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'sold' })
      .where('id', '=', item.id)
      .execute();
    return item;
  };

  const leggings = (size = '6') => ({
    title: 'Lululemon Align leggings',
    brand: 'Lululemon',
    category: LEGGINGS,
    sizeLabel: size,
  });

  describe('the item price screen', () => {
    let item: { id: string };

    beforeAll(async () => {
      await sell('depop', leggings(), 2200);
      await sell('depop', { ...leggings('8'), brand: 'LULULEMON' }, 3000);
      await sell('depop', leggings(), 2800);
      await sell('mercari', leggings(), 2000);
      await sell('mercari', leggings(), 2600);
      await sell('poshmark', leggings(), 3200);
      await sell('poshmark', leggings(), 3400);
      await sell('ebay', leggings(), 1900);
      await sell('ebay', leggings(), 2100);
      // None of these count: canceled, too old, another category, another account's.
      await sell('depop', leggings(), 9900, { status: 'canceled' });
      await sell('depop', leggings(), 9900, { daysAgo: OWN_HISTORY_WINDOW_DAYS + 5 });
      await sell('depop', { ...leggings(), category: 'clothing/tops/tank_tops' }, 9900);
      await sell('depop', leggings(), 9900, { owner: other, as: otherToken });
      await sell('depop', leggings(), 9900, { owner: other, as: otherToken });
      item = await createItem({ ...leggings(), cost: usd(800) });
    });

    const pricing = (itemId: string) => api.call('getItemPricing', { token, params: { itemId } });

    it("shows the seller's own similar sales per marketplace, never setting a tier", async () => {
      const response = await pricing(item.id);
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.noSoldDataMessage).toBeUndefined();
      const label = (name: string) =>
        `Your sales of similar Lululemon items on ${name} (last ${String(OWN_HISTORY_WINDOW_DAYS)} days)`;
      expect(body.soldComparables).toEqual([
        {
          source: 'own_history',
          label: label('eBay'),
          sampleSize: 2,
          low: usd(1950),
          median: usd(2000),
          high: usd(2050),
          fetchedAt: body.generatedAt,
        },
        {
          source: 'own_history',
          label: label('Depop'),
          sampleSize: 3,
          low: usd(2500),
          median: usd(2800),
          high: usd(2900),
          fetchedAt: body.generatedAt,
        },
        expect.objectContaining({ label: label('Poshmark'), sampleSize: 2, median: usd(3300) }),
        expect.objectContaining({ label: label('Mercari'), sampleSize: 2, median: usd(2300) }),
      ]);
      // Not bound to one listing context, so the price screen shows them.
      expect(body.soldComparables?.every((sold) => sold.marketplace === undefined)).toBe(true);
      expect(body.tiers).toEqual([]);
    });

    it('shows a seller only the marketplaces whose sales history passed live', async () => {
      useMarketplaceFeatures('verified');
      const sellerView = (await pricing(item.id)).body.soldComparables ?? [];
      expect(sellerView.map((sold) => sold.label)).toEqual([
        expect.stringContaining('on Depop'),
        expect.stringContaining('on Mercari'),
      ]);

      // The owner's Test mode shows every built one, to live-test it.
      await api.db
        .updateTable('account')
        .set({ test_mode: true })
        .where('id', '=', tenant.accountId)
        .execute();
      expect((await pricing(item.id)).body.soldComparables).toHaveLength(4);
    });

    it("never counts the item's own sale, and needs two similar sales on a marketplace", async () => {
      const sold = await sell('depop', { ...leggings(), brand: 'Girlfriend Collective' }, 4000);
      await sell('depop', { ...leggings(), brand: 'Girlfriend Collective' }, 4400);
      const body = (await pricing(sold.id)).body;
      expect(body.soldComparables).toBeUndefined();
      expect(body.noSoldDataMessage).toBe(NO_SOLD_DATA_MESSAGE);
    });

    it('has no own history for an item without a brand, or of a brand never sold', async () => {
      const unbranded = await createItem({ title: 'Black leggings', category: LEGGINGS });
      expect((await pricing(unbranded.id)).body.noSoldDataMessage).toBe(NO_SOLD_DATA_MESSAGE);
      const unsold = await createItem({ ...leggings(), brand: 'Athleta' });
      expect((await pricing(unsold.id)).body.soldComparables).toBeUndefined();
    });

    it("shows an item without a category its brand's sales", async () => {
      const uncategorized = await createItem({ brand: 'lululemon' });
      const labels = ((await pricing(uncategorized.id)).body.soldComparables ?? []).map((sold) => [
        sold.label,
        sold.sampleSize,
      ]);
      expect(labels).toContainEqual([expect.stringContaining('Your lululemon sales on Depop'), 4]);
    });
  });

  describe('the sourcing kit', () => {
    it("holds only the account's own sales, and nothing without any", async () => {
      const response = await api.call('getSourcingKit', { token: otherToken });
      expect(response.status).toBe(200);
      // The other account's only sales: two Lululemon leggings on Depop.
      expect(
        response.body.buckets.map((bucket) => [
          bucket.brandKey,
          bucket.marketplaces.map((line) => [line.marketplace, line.soldCount]),
        ]),
      ).toEqual([
        ['lululemon', [['depop', 2]]],
        ['lululemon', [['depop', 2]]],
        ['lululemon', [['depop', 2]]],
      ]);

      const fresh = await api.signIn('sourcing.fresh@example.com');
      const empty = await api.call('getSourcingKit', { token: fresh });
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({
        version: SOURCING_KIT_VERSION,
        generatedAt: empty.body.generatedAt,
        windowDays: OWN_HISTORY_WINDOW_DAYS,
        call: { worthListing: usd(800), minComparisons: 3 },
        buckets: [],
        insights: { soldCount: 0, daysToSellCount: 0, lookFor: [], best: [], worst: [] },
      });
    });

    it("groups the account's sales with its unsold items, gated like the price screen", async () => {
      const unsold = await createItem(leggings());
      await api.db
        .updateTable('inventory_item')
        .set({ status: 'listed' })
        .where('id', '=', unsold.id)
        .execute();
      useMarketplaceFeatures('verified');
      const kit = (await api.call('getSourcingKit', { token })).body;
      const brand = kit.buckets.find(
        (bucket) => bucket.brandKey === 'lululemon' && bucket.category === undefined,
      );
      expect(brand?.brand).toBe('Lululemon');
      // A seller's kit has only the marketplaces whose sales history passed live.
      expect(brand?.marketplaces.map((line) => line.marketplace)).toEqual(['depop', 'mercari']);

      const size6 = kit.buckets.find(
        (bucket) =>
          bucket.brandKey === 'lululemon' &&
          bucket.category === LEGGINGS &&
          bucket.sizeBucket === '6',
      );
      const depop = size6?.marketplaces.find((line) => line.marketplace === 'depop');
      const table = feeTableFor('depop', new Date(kit.generatedAt));
      expect(depop).toEqual({
        marketplace: 'depop',
        soldCount: 2,
        low: usd(2350),
        median: usd(2500),
        high: usd(2650),
        medianPayout: usd(
          Math.round(
            (2200 - estimateFeesCents(table, 2200) + 2800 - estimateFeesCents(table, 2800)) / 2,
          ),
        ),
        feeTableVersion: table.version,
        displayOnly: false,
      });
      expect(size6?.unsoldCount).toBe(1);

      // The offline call's thresholds and sales: Depop's and Mercari's together ($20, $22, $26,
      // $28), after Depop's fees on the tie, worked out as the scan works them.
      expect(kit.version).toBe(2);
      expect(kit.call).toEqual({ worthListing: usd(800), minComparisons: 3 });
      const fee = await payoutFees(api.db, tenant, 'depop', new Date(kit.generatedAt));
      expect(size6?.forCall).toEqual({
        soldCount: 4,
        low: usd(2150),
        high: usd(2650),
        payoutMarketplace: 'depop',
        conservativePayout: usd(2150 - fee(2150)),
        optimisticPayout: usd(2650 - fee(2650)),
      });
    });

    it('reads the sales and stock as advice: brand and item type pairs, days from Listora listings', async () => {
      const seller = 'sourcing.insights@example.com';
      const as = await api.signIn(seller);
      const owner = await api.tenantOf(seller);
      const JEANS = 'clothing/bottoms/jeans';
      const JACKETS = 'clothing/outerwear/jackets';
      const jeans = {
        title: 'Madewell jeans',
        brand: 'Madewell',
        category: JEANS,
        sizeLabel: '28',
      };
      /** A listing of the item on Depop, listed `daysAgo` back; Listora's when its create succeeded. */
      const listing = async (itemId: string, daysAgo: number, throughListora: boolean) => {
        const row = await api.db
          .insertInto('marketplace_listing')
          .values({
            account_id: owner.accountId,
            item_id: itemId,
            marketplace: 'depop',
            status: 'sold',
            listed_at: new Date(api.clock.now - daysAgo * DAY_MS),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (!throughListora) return;
        await api.db
          .insertInto('marketplace_operation')
          .values({
            account_id: owner.accountId,
            listing_id: row.id,
            kind: 'create',
            idempotency_key: `insights-${row.id}`,
            desired: jsonb({ status: 'active' }),
            status: 'succeeded',
            success_evidence: 'read_back',
            origin: 'user',
            content: jsonb({}),
          })
          .execute();
      };
      // Three jeans sold 5 days ago, listed through Listora 15, 25, and 35 days back. The
      // first also had an imported listing from earlier, whose date is when Listora read it.
      for (const [index, listedDaysAgo] of [20, 30, 40].entries()) {
        const item = await sell('depop', jeans, 3000, { owner, as, daysAgo: 5 });
        await listing(item.id, listedDaysAgo, true);
        if (index === 0) await listing(item.id, 300, false);
      }
      // A fourth sold with only an imported listing: it sold, with no day count.
      const imported = await sell('depop', jeans, 3000, { owner, as, daysAgo: 5 });
      await listing(imported.id, 200, false);
      // One pair of jeans in stock for 60 days; three jackets that never sold.
      const inStock = async (details: Record<string, unknown>) => {
        const item = await createItem(details, as);
        const added = new Date(api.clock.now - 60 * DAY_MS);
        await sql`update inventory_item set status = 'listed', created_at = ${added}
          where id = ${item.id}`.execute(api.db);
      };
      await inStock(jeans);
      for (let count = 0; count < 3; count += 1) {
        await inStock({ title: 'Madewell jacket', brand: 'Madewell', category: JACKETS });
      }

      const kit = (await api.call('getSourcingKit', { token: as })).body;
      expect(kit.insights.soldCount).toBe(4);
      expect(kit.insights.daysToSellCount).toBe(3);
      const fee = await payoutFees(api.db, owner, 'depop', new Date(kit.generatedAt));
      const best = {
        brand: 'Madewell',
        brandKey: 'madewell',
        category: JEANS,
        soldCount: 4,
        unsoldCount: 1,
        inStockCount: 1,
        sellThroughBasisPoints: 8000,
        medianDaysToSell: 25,
        medianPayout: usd(3000 - fee(3000)),
      };
      expect(kit.insights.best).toEqual([best]);
      expect(kit.insights.lookFor).toEqual([best]);
      expect(kit.insights.worst).toEqual([
        {
          brand: 'Madewell',
          brandKey: 'madewell',
          category: JACKETS,
          soldCount: 0,
          unsoldCount: 3,
          inStockCount: 3,
          sellThroughBasisPoints: 0,
        },
      ]);

      // Another account sees none of it: its own two sales are too few to judge.
      const theirs = (await api.call('getSourcingKit', { token: otherToken })).body.insights;
      expect(theirs).toEqual({
        soldCount: 2,
        daysToSellCount: 0,
        lookFor: [],
        best: [],
        worst: [],
      });
    });

    it("shows eBay's sales display only in the owner's Test mode", async () => {
      useMarketplaceFeatures('verified');
      await api.db
        .updateTable('account')
        .set({ test_mode: true })
        .where('id', '=', tenant.accountId)
        .execute();
      const kit = (await api.call('getSourcingKit', { token })).body;
      const brand = kit.buckets.find(
        (bucket) => bucket.brandKey === 'lululemon' && bucket.category === undefined,
      );
      expect(brand?.marketplaces.map((line) => [line.marketplace, line.displayOnly])).toEqual([
        ['ebay', true],
        ['depop', false],
        ['poshmark', false],
        ['mercari', false],
      ]);
    });
  });
});
