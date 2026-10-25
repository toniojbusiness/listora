import { randomBytes } from 'node:crypto';

import { jsonb, type JsonObject, type Marketplace } from '@listora/db';
import {
  claimsSoldData,
  computeFloor,
  estimateFeesCents,
  feeEstimator,
  feeTableFor,
  NO_SOLD_DATA_MESSAGE,
  type SoldDataPayload,
} from '@listora/pricing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';
import { insertPricingSnapshot } from './repository.ts';

const OWNER = 'pricing.owner@example.com';
const OTHER = 'pricing.other@example.com';
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

const ESTIMATE = {
  label: 'whatever the model wrote',
  low: usd(1800),
  mid: usd(2600),
  high: usd(3800),
  confidence: 0.55,
};

const DEPOP_SOLD: SoldDataPayload = {
  label: 'Sold on Depop (last 90 days)',
  sampleSize: 9,
  low: usd(2000),
  median: usd(2700),
  high: usd(3900),
  marketplace: 'depop',
};

/** Every string in a response body with its path, for the label scan. */
function strings(value: unknown, path = ''): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, path === '' ? key : `${path}.${key}`),
  );
}

describe('pricing (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('pricing');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  const createItem = async (details: Record<string, unknown> = {}) => {
    const response = await api.call('createItem', { token, body: { details } });
    expect(response.status).toBe(201);
    return response.body;
  };

  const pricing = (itemId: string, query: Record<string, number> = {}, as = token) =>
    api.call('getItemPricing', { token: as, params: { itemId }, query });

  const addAnalysis = async (itemId: string, output: JsonObject | null, status = 'succeeded') => {
    const row = await api.db
      .insertInto('ai_analysis')
      .values({
        account_id: tenant.accountId,
        item_id: itemId,
        photo_set_hash: randomBytes(32).toString('hex'),
        tier: 'standard',
        model: 'claude-haiku-5-5',
        status: status as 'succeeded',
        output: output === null ? null : jsonb(output),
        ...(status === 'succeeded' || status === 'failed' ? { completed_at: new Date() } : {}),
        ...(status === 'failed'
          ? { error_code: 'invalid_output', error_message: 'failed', error_retryable: true }
          : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  };

  const aiSnapshots = (itemId: string) =>
    api.db
      .selectFrom('pricing_snapshot')
      .select(['source', 'payload'])
      .where('item_id', '=', itemId)
      .where('source', '=', 'ai_estimate')
      .execute();

  /**
   * A one-item sale with actual fees, `daysAgo` days back: one marketplace fee line of
   * `feesCents`, or else the given `lines`.
   */
  const addSale = async (
    marketplace: Marketplace,
    itemId: string,
    salePriceCents: number,
    feesCents: number,
    options: {
      status?: 'canceled';
      daysAgo?: number;
      source?: 'estimated';
      lines?: { kind: 'marketplace' | 'payment'; amountCents: number }[];
    } = {},
  ) => {
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: tenant.accountId,
        marketplace,
        sold_at: new Date(Date.now() - (options.daysAgo ?? 1) * 24 * 60 * 60 * 1000),
        detection_source: 'manual',
        ...(options.status ? { status: options.status, canceled_at: new Date() } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: tenant.accountId,
        sale_id: sale.id,
        marketplace,
        item_id: itemId,
        sale_price_cents: salePriceCents,
      })
      .execute();
    const lines = options.lines ?? [{ kind: 'marketplace', amountCents: feesCents }];
    await api.db
      .insertInto('fee_line')
      .values(
        lines.map((line) => ({
          account_id: tenant.accountId,
          sale_id: sale.id,
          kind: line.kind,
          amount_cents: line.amountCents,
          source: options.source ?? 'actual',
        })),
      )
      .execute();
  };

  describe('an item without sold data', () => {
    it('shows the floor per marketplace, the labeled AI estimate, tiers, and research links', async () => {
      const item = await createItem({
        title: 'Patagonia Retro-X fleece jacket',
        cost: usd(1000),
      });
      await addAnalysis(item.id, { priceEstimate: ESTIMATE, needsEscalation: false });

      const response = await pricing(item.id, { shippingCents: 500, minimumProfitCents: 700 });
      expect(response.status).toBe(200);
      const body = response.body;

      expect(body.itemId).toBe(item.id);
      expect(body.soldComparables).toBeUndefined();
      expect(body.noSoldDataMessage).toBe('No sold data available for this item');
      expect(body.aiEstimate).toEqual({
        label: 'AI estimate - not based on sold listings',
        low: usd(1800),
        mid: usd(2600),
        high: usd(3800),
        confidence: 0.55,
      });

      expect(body.floors.map((floor) => floor.marketplace)).toEqual([
        'ebay',
        'depop',
        'poshmark',
        'mercari',
      ]);
      for (const floor of body.floors) {
        const { cost, estimatedFees, shipping, minimumProfit } = floor.breakdown;
        expect(cost).toEqual(usd(1000));
        expect(shipping).toEqual(usd(500));
        expect(minimumProfit).toEqual(usd(700));
        expect(floor.floorPrice.amountCents).toBe(2200 + estimatedFees.amountCents);
        const table = feeTableFor(floor.marketplace, new Date());
        expect(floor.feeTableVersion).toBe(table.version);
        expect(estimatedFees.amountCents).toBe(
          estimateFeesCents(table, floor.floorPrice.amountCents),
        );
        expect(floor.feeSource).toBe('fee_table');
      }

      const highestFloor = Math.max(...body.floors.map((floor) => floor.floorPrice.amountCents));
      expect(body.tiers.map((tier) => tier.tier)).toEqual([
        'quick_sale',
        'recommended',
        'higher_profit',
      ]);
      for (const tier of body.tiers) {
        expect(tier.price.amountCents).toBeGreaterThanOrEqual(highestFloor);
        expect(['ai_estimate', 'cost_floor']).toContain(tier.basis);
        expect(tier.label).toMatch(/\((AI estimate|cost floor)\)$/);
      }

      expect(body.researchLinks.map((link) => new URL(link.url).hostname)).toEqual([
        'www.ebay.com',
        'www.ebay.com',
      ]);
      expect(new URL(body.researchLinks[0]?.url ?? '').searchParams.get('_nkw')).toBe(
        'Patagonia Retro-X fleece jacket',
      );
    });

    it('never says "sold" or "comps" except in the fixed no-data texts and research links', async () => {
      const item = await createItem({ title: 'Sold out Nike Dunk', cost: usd(4000) });
      await addAnalysis(item.id, { priceEstimate: ESTIMATE });
      const body = (await pricing(item.id)).body;
      const claims = strings(body).filter(({ text }) => claimsSoldData(text));
      expect(claims.map(({ path }) => path)).toEqual([
        'noSoldDataMessage',
        'aiEstimate.label',
        'researchLinks.0.label',
        // The item's own title in the research URL.
        'researchLinks.0.url',
        'researchLinks.1.url',
      ]);
    });

    it('records the estimate as an ai_estimate snapshot once per analysis', async () => {
      const item = await createItem({ cost: usd(1000) });
      const analysisId = await addAnalysis(item.id, { priceEstimate: ESTIMATE });
      await pricing(item.id);
      await pricing(item.id);
      const rows = await aiSnapshots(item.id);
      expect(rows).toEqual([
        {
          source: 'ai_estimate',
          payload: {
            analysisId,
            low: usd(1800),
            mid: usd(2600),
            high: usd(3800),
            confidence: 0.55,
          },
        },
      ]);
    });

    it('uses the accepted analysis, else the latest succeeded one, never an older estimate', async () => {
      const item = await createItem({ cost: usd(1000) });
      const first = await addAnalysis(item.id, {
        priceEstimate: { ...ESTIMATE, mid: usd(2000), high: usd(2100) },
      });
      await addAnalysis(item.id, { priceEstimate: { ...ESTIMATE, mid: usd(3000) } });
      await addAnalysis(item.id, null, 'failed');
      expect((await pricing(item.id)).body.aiEstimate?.mid).toEqual(usd(3000));

      const accepted = await api.call('replaceItem', {
        token,
        params: { itemId: item.id },
        body: {
          expectedVersion: item.version,
          details: { cost: usd(1000), acceptedAnalysisId: first },
        },
      });
      expect(accepted.status).toBe(200);
      expect((await pricing(item.id)).body.aiEstimate?.mid).toEqual(usd(2000));
    });

    it('shows no estimate or tiers when the analysis has none or a malformed one', async () => {
      const none = await createItem({ cost: usd(1000) });
      await addAnalysis(none.id, { needsEscalation: false });
      const noneBody = (await pricing(none.id)).body;
      expect(noneBody.aiEstimate).toBeUndefined();
      expect(noneBody.tiers).toEqual([]);
      expect(noneBody.floors).toHaveLength(4);

      const malformed = await createItem({ cost: usd(1000) });
      await addAnalysis(malformed.id, {
        priceEstimate: { ...ESTIMATE, low: usd(9000) }, // low above mid
      });
      const malformedBody = (await pricing(malformed.id)).body;
      expect(malformedBody.aiEstimate).toBeUndefined();
      expect(malformedBody.tiers).toEqual([]);
      expect(await aiSnapshots(malformed.id)).toEqual([]);
    });

    it('has no floors without a cost and no research links without any words', async () => {
      const item = await createItem();
      const body = (await pricing(item.id)).body;
      expect(body).toEqual({
        itemId: item.id,
        noSoldDataMessage: NO_SOLD_DATA_MESSAGE,
        tiers: [],
        floors: [],
        researchLinks: [],
        generatedAt: body.generatedAt,
      });
    });
  });

  describe('sold data snapshots', () => {
    it('show unexpired real sold data as comparables and drop the no-data message', async () => {
      const item = await createItem({ title: 'Levi’s 501', cost: usd(1000) });
      await addAnalysis(item.id, { priceEstimate: ESTIMATE });
      const tiersBefore = (await pricing(item.id)).body.tiers;

      await insertPricingSnapshot(api.db, tenant, item.id, {
        source: 'depop_inspiration',
        payload: { ...DEPOP_SOLD, median: usd(2500) },
        fetchedAt: new Date(Date.now() - 60_000),
      });
      // A newer snapshot of the same source and context replaces the older one.
      await insertPricingSnapshot(api.db, tenant, item.id, {
        source: 'depop_inspiration',
        payload: DEPOP_SOLD,
      });
      await insertPricingSnapshot(api.db, tenant, item.id, {
        source: 'own_history',
        payload: { ...DEPOP_SOLD, label: 'Your sales of similar items', marketplace: undefined },
        expiresAt: new Date(Date.now() - 1_000),
        fetchedAt: new Date(Date.now() - 60_000),
      });

      const body = (await pricing(item.id)).body;
      expect(body.noSoldDataMessage).toBeUndefined();
      expect(body.soldComparables).toEqual([
        expect.objectContaining({
          source: 'depop_inspiration',
          marketplace: 'depop',
          label: 'Sold on Depop (last 90 days)',
          sampleSize: 9,
          median: usd(2700),
        }),
      ]);
      // Sold data is shown, never used to set the tiers.
      expect(body.tiers).toEqual(tiersBefore);
    });

    it('never shows a malformed snapshot or an estimate snapshot as sold data', async () => {
      const item = await createItem({ cost: usd(1000) });
      // Written behind the repository's back: wrong shapes under each source.
      await api.db
        .insertInto('pricing_snapshot')
        .values([
          {
            account_id: tenant.accountId,
            item_id: item.id,
            source: 'own_history',
            payload: jsonb({ label: 'Sold for $40', price: 4000 }),
          },
          {
            account_id: tenant.accountId,
            item_id: item.id,
            source: 'ai_estimate',
            payload: jsonb(DEPOP_SOLD as unknown as JsonObject),
          },
        ])
        .execute();
      const body = (await pricing(item.id)).body;
      expect(body.soldComparables).toBeUndefined();
      expect(body.noSoldDataMessage).toBe(NO_SOLD_DATA_MESSAGE);
      expect(body.aiEstimate).toBeUndefined();
    });

    it('keep Depop Pricing Inspiration on Depop and Marketplace Insights on eBay', async () => {
      const item = await createItem({ cost: usd(1000) });
      const unbound = { ...DEPOP_SOLD, marketplace: undefined };
      await expect(
        insertPricingSnapshot(api.db, tenant, item.id, {
          source: 'depop_inspiration',
          payload: unbound,
        }),
      ).rejects.toThrow(/marketplace depop/);
      await expect(
        insertPricingSnapshot(api.db, tenant, item.id, {
          source: 'ebay_mi',
          payload: DEPOP_SOLD,
        }),
      ).rejects.toThrow(/marketplace ebay/);
      // Written behind the repository's back: never shown outside its listing context.
      await api.db
        .insertInto('pricing_snapshot')
        .values([
          {
            account_id: tenant.accountId,
            item_id: item.id,
            source: 'depop_inspiration',
            payload: jsonb(unbound as unknown as JsonObject),
          },
          {
            account_id: tenant.accountId,
            item_id: item.id,
            source: 'depop_inspiration',
            payload: jsonb({ ...DEPOP_SOLD, marketplace: 'poshmark' }),
          },
        ])
        .execute();
      const body = (await pricing(item.id)).body;
      expect(body.soldComparables).toBeUndefined();
      expect(body.noSoldDataMessage).toBe(NO_SOLD_DATA_MESSAGE);
    });

    it('refuses to store a payload under a source it does not match', async () => {
      const item = await createItem();
      await expect(
        insertPricingSnapshot(api.db, tenant, item.id, {
          source: 'ai_estimate',
          payload: DEPOP_SOLD as never,
        }),
      ).rejects.toThrow();
      await expect(
        api.db
          .insertInto('pricing_snapshot')
          .values({
            account_id: tenant.accountId,
            item_id: item.id,
            source: 'cost_floor' as never,
            payload: jsonb({}),
          })
          .execute(),
      ).rejects.toThrow(/pricing_snapshot_source_check/);
    });
  });

  describe('actual fees from order data', () => {
    it('scale Mercari floors to the fees Mercari actually charged', async () => {
      const sold = await createItem();
      // Mercari charged 15% on these sales instead of the table's 10%.
      await addSale('mercari', sold.id, 2000, 300);
      await addSale('mercari', sold.id, 4000, 600);
      await addSale('mercari', sold.id, 6000, 900);
      // Left out: canceled, too old, and estimated fees.
      await addSale('mercari', sold.id, 2000, 2000, { status: 'canceled' });
      await addSale('mercari', sold.id, 2000, 2000, { daysAgo: 400 });
      await addSale('mercari', sold.id, 2000, 2000, { source: 'estimated' });

      const item = await createItem({ cost: usd(1000) });
      const floors = (await pricing(item.id)).body.floors;
      const mercari = floors.find((floor) => floor.marketplace === 'mercari');
      expect(mercari?.feeSource).toBe('actual_fees');
      // 1000 + 15% fees: 1177 keeps 1000 (fees 177 = ceil(118 * 1.5)).
      expect(mercari?.floorPrice).toEqual(usd(1177));
      expect(mercari?.breakdown.estimatedFees).toEqual(usd(177));
    });

    it('calibrate only from sales with complete fee data, compared on their sale day', async () => {
      const sold = await createItem();
      // Before Depop's first table took effect: compared with that first table.
      const prices = [2000, 4000, 6000];
      const table = feeTableFor('depop', new Date());
      for (const price of prices) {
        await addSale('depop', sold.id, price, 0, {
          daysAgo: 30,
          lines: [{ kind: 'payment', amountCents: 2 * estimateFeesCents(table, price) }],
        });
      }
      // Left out: no payment fee line, a zero-amount placeholder, and a refunded fee.
      await addSale('depop', sold.id, 2000, 0, {
        lines: [{ kind: 'marketplace', amountCents: 5 }],
      });
      await addSale('depop', sold.id, 2000, 0, {
        lines: [
          { kind: 'payment', amountCents: 1000 },
          { kind: 'marketplace', amountCents: 0 },
        ],
      });
      await addSale('depop', sold.id, 2000, 0, {
        lines: [
          { kind: 'payment', amountCents: 1000 },
          { kind: 'payment', amountCents: -1000 },
        ],
      });

      const item = await createItem({ cost: usd(1000) });
      const depop = (await pricing(item.id)).body.floors.find(
        (floor) => floor.marketplace === 'depop',
      );
      expect(depop?.feeSource).toBe('actual_fees');
      const estimated = prices.reduce((sum, price) => sum + estimateFeesCents(table, price), 0);
      const expected = computeFloor(
        { costCents: 1000, shippingCents: 0, minimumProfitCents: 0 },
        feeEstimator(table, {
          sales: 3,
          actualFeesCents: 2 * estimated,
          estimatedFeesCents: estimated,
        }),
      );
      expect(depop?.floorPrice).toEqual(usd(expected.floorPriceCents));
      expect(depop?.breakdown.estimatedFees).toEqual(usd(expected.estimatedFeesCents));
    });

    it('ignore actual fees implausibly far below the table', async () => {
      const sold = await createItem();
      // Poshmark's $2.95 under $15 recorded as $0.20: missing or netted-down fee lines.
      for (const price of [1000, 1200, 1400]) await addSale('poshmark', sold.id, price, 20);
      const item = await createItem({ cost: usd(1000) });
      const poshmark = (await pricing(item.id)).body.floors.find(
        (floor) => floor.marketplace === 'poshmark',
      );
      expect(poshmark?.feeSource).toBe('fee_table');
      expect(poshmark?.floorPrice).toEqual(usd(1295));
    });

    it('never let eBay order data change an eBay floor (eBay API License)', async () => {
      const sold = await createItem();
      for (const price of [2000, 4000, 6000]) await addSale('ebay', sold.id, price, price / 4);
      const item = await createItem({ cost: usd(1000) });
      const ebay = (await pricing(item.id)).body.floors.find(
        (floor) => floor.marketplace === 'ebay',
      );
      expect(ebay?.feeSource).toBe('fee_table');
      const table = feeTableFor('ebay', new Date());
      expect(ebay?.breakdown.estimatedFees.amountCents).toBe(
        estimateFeesCents(table, ebay?.floorPrice.amountCents ?? 0),
      );
    });
  });

  describe('access and validation', () => {
    it('answers 404 for an unknown item and for another account’s item', async () => {
      const item = await createItem({ cost: usd(1000) });
      const missing = await pricing('0190a2b8-0000-7000-8000-000000000000');
      expect(missing.status).toBe(404);
      const otherToken = await api.signIn(OTHER);
      const foreign = await pricing(item.id, {}, otherToken);
      expect(foreign.status).toBe(404);
      expect(foreign.error.code).toBe('not_found');
    });

    it('needs a signed-in user', async () => {
      const item = await createItem();
      const response = await api.call('getItemPricing', { params: { itemId: item.id } });
      expect(response.status).toBe(401);
    });

    it('rejects negative or fractional amounts', async () => {
      const item = await createItem({ cost: usd(1000) });
      const negative = await pricing(item.id, { shippingCents: -1 });
      expect(negative.status).toBe(422);
      expect(fieldsOf(negative)).toEqual(['shippingCents']);
      const fractional = await pricing(item.id, { minimumProfitCents: 1.5 });
      expect(fractional.status).toBe(422);
      expect(fieldsOf(fractional)).toEqual(['minimumProfitCents']);
    });
  });
});
