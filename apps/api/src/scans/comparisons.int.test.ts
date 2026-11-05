import { SCAN_OUTPUT_NAME, SCAN_RESEARCH_OUTPUT_NAME } from '@listora/analysis';
import { isFeatureOn, SELLER_FEATURES, useMarketplaceFeatures } from '@listora/marketplaces';
import { ASKING_PRICES_LABEL, claimsSoldData, marketSoldLabel } from '@listora/pricing';
import { itemResearchKey } from '@listora/sourcing';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

import { COMPARISON_LIMITS } from './comparisons.ts';

// Invented sellers and items; no real shop's data.
const OWNER = 'comparisons.owner@example.com';
const OTHER = 'comparisons.other@example.com';

/** The AI's answer for a scan, in the model's flat shape: a pair of Levi's 501 jeans. */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    brand: "Levi's",
    item: 'light wash straight jeans',
    line: '501',
    styleNumber: '',
    era: '',
    material: 'denim',
    category: 'clothing/bottoms/jeans',
    department: 'women',
    sizeLabel: '28',
    condition: 'pre_owned_good',
    identityConfidence: 0.9,
    priceEstimate: { lowCents: 2000, midCents: 3000, highCents: 4000 },
    retailPriceCents: 0,
    style: '',
    searchWords: 'levis 501 jeans',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    ...overrides,
  };
}

/** What the phone answers for a read: six close matches asking $15 to $25, numbers only. */
const READ = {
  outcome: 'read' as const,
  stats: {
    level: 'model' as const,
    forSale: { count: 6, lowCents: 1500, medianCents: 2000, highCents: 2500 },
    read: { sold: 0, forSale: 24 },
  },
  forSaleTotal: 40,
  ms: 900,
};

/**
 * What the phone answers for an eBay read: nine close matches sold for $18 to $30 in the last 14
 * days, four for sale at $25 to $35, and the searches' own counts.
 */
const EBAY_READ = {
  outcome: 'read' as const,
  stats: {
    level: 'model_and_size' as const,
    sold: { count: 9, lowCents: 1800, medianCents: 2400, highCents: 3000, windowDays: 14 },
    forSale: { count: 4, lowCents: 2500, medianCents: 2900, highCents: 3500 },
    read: { sold: 58, forSale: 60 },
  },
  forSaleTotal: 320,
  soldTotal: 410,
  ms: 2400,
};

/**
 * What the phone answers for a Poshmark read: 44 close matches sold for $18 to $34 in the last 42
 * days, 41 for sale at $23 to $40, and the for-sale search's count; Poshmark's sold search counts
 * every sale it ever had, so no sold count comes with it.
 */
const POSHMARK_READ = {
  outcome: 'read' as const,
  stats: {
    level: 'model' as const,
    sold: { count: 44, lowCents: 1800, medianCents: 2350, highCents: 3400, windowDays: 42 },
    forSale: { count: 41, lowCents: 2300, medianCents: 3000, highCents: 4000 },
    read: { sold: 47, forSale: 48 },
  },
  forSaleTotal: 97_581,
  ms: 3100,
};

/**
 * What the phone answers for a Mercari read: seven close matches sold for $20 to $28, the oldest
 * 21 days before; 24 of the 30 latest sold results read sold in the last 30 days; and Mercari's
 * own count of the search for sale.
 */
const MERCARI_READ = {
  outcome: 'read' as const,
  stats: {
    level: 'model' as const,
    sold: { count: 7, lowCents: 2000, medianCents: 2400, highCents: 2800, windowDays: 21 },
    read: { sold: 30, forSale: 30 },
  },
  forSaleTotal: 1400,
  soldTotal: 24,
  ms: 3100,
};

/**
 * What the phone answers for a read of Vinted, which shows a visitor no sold listings: five close
 * matches asking $25 to $30, and Vinted's "500+" results as 500. Numbers only.
 */
const VINTED_READ = {
  outcome: 'read' as const,
  stats: {
    level: 'model_and_size' as const,
    forSale: { count: 5, lowCents: 2500, medianCents: 2800, highCents: 3000 },
    read: { sold: 0, forSale: 96 },
  },
  forSaleTotal: 500,
  ms: 2100,
};

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the thrift scan marketplace comparisons (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let otherToken: string;
  let seed = 0;

  beforeAll(async () => {
    api = await createTestApi('scan_comparisons');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    otherToken = await api.signIn(OTHER);
  });

  afterEach(async () => {
    useMarketplaceFeatures('all');
    await api.db.deleteFrom('market_comparison').execute();
  });

  afterAll(async () => {
    await api.close();
  });

  async function scanImage(output: unknown) {
    seed += 1;
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: seed % 256, g: 90, b: 9 } },
      })
        .jpeg()
        .toBuffer(),
    );
    api.aiControls.fixtures[photoSetHash([sha256Hex(bytes)])] = {
      outputs: { [SCAN_OUTPUT_NAME]: output },
    };
    return Buffer.from(bytes).toString('base64');
  }

  async function scanOf(output: unknown, as = token) {
    const run = await api.call('createSourcingRun', { token: as, body: {} });
    expect(run.status).toBe(201);
    const response = await api.call('createScan', {
      token: as,
      body: {
        runId: run.body.id,
        images: [{ role: 'item', jpegBase64: await scanImage(output) }],
      },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  function depopOf(scan: Awaited<ReturnType<typeof scanOf>>) {
    const row = scan.comparisons?.find((one) => one.marketplace === 'depop');
    if (row === undefined) throw new Error('the scan has no Depop comparison');
    return row;
  }

  function ebayOf(scan: Awaited<ReturnType<typeof scanOf>>) {
    const row = scan.comparisons?.find((one) => one.marketplace === 'ebay');
    if (row === undefined) throw new Error('the scan has no eBay comparison');
    return row;
  }

  function poshmarkOf(scan: Awaited<ReturnType<typeof scanOf>>) {
    const row = scan.comparisons?.find((one) => one.marketplace === 'poshmark');
    if (row === undefined) throw new Error('the scan has no Poshmark comparison');
    return row;
  }

  function mercariOf(scan: Awaited<ReturnType<typeof scanOf>>) {
    const row = scan.comparisons?.find((one) => one.marketplace === 'mercari');
    if (row === undefined) throw new Error('the scan has no Mercari comparison');
    return row;
  }

  function vintedOf(scan: Awaited<ReturnType<typeof scanOf>>) {
    const row = scan.comparisons?.find((one) => one.marketplace === 'vinted');
    if (row === undefined) throw new Error('the scan has no Vinted comparison');
    return row;
  }

  /** A sold pair of the owner's Levi's 501 jeans: a one-item sale on Vinted, three days back. */
  async function soldOnVinted(cents: number) {
    const item = await api.call('createItem', {
      token,
      body: { details: { title: '501', brand: "Levi's", category: 'clothing/bottoms/jeans' } },
    });
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: tenant.accountId,
        marketplace: 'vinted',
        sold_at: new Date(api.clock.now - 3 * DAY_MS),
        detection_source: 'manual',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: tenant.accountId,
        sale_id: sale.id,
        marketplace: 'vinted',
        item_id: item.body.id,
        sale_price_cents: cents,
      })
      .execute();
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'sold' })
      .where('id', '=', item.body.id)
      .execute();
  }

  async function answerRead(scanId: string, comparisonId: string, body: unknown, as = token) {
    return api.call('saveScanComparison', {
      token: as,
      params: { scanId, comparisonId },
      body: body as never,
    });
  }

  /**
   * The phone's answer to one read, and the scan once its prices are in: the other reads the
   * phone still has are answered as failed (as the app answers a read it can't make), and the
   * web research (which these items have no fixture for, so it fails) comes back.
   */
  async function answerAndPrice(scanId: string, comparisonId: string, body: unknown) {
    const answered = await answerRead(scanId, comparisonId, body);
    expect(answered.status).toBe(200);
    for (const other of answered.body.comparisons ?? []) {
      if (other.read === undefined) continue;
      const failed = await answerRead(scanId, other.read.id, { outcome: 'failed', ms: 0 });
      expect(failed.status).toBe(200);
    }
    const priced = await api.call('researchScan', { token, params: { scanId } });
    expect(priced.status).toBe(200);
    expect(priced.body.pricing?.status).toBe('ready');
    return priced;
  }

  async function reads(
    marketplace: 'depop' | 'ebay' | 'poshmark' | 'mercari' | 'vinted' = 'depop',
  ) {
    return api.db
      .selectFrom('market_comparison')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .where('marketplace', '=', marketplace)
      .orderBy('created_at')
      .execute();
  }

  it('hands the phone a read of Depop by brand, type, model, and size, and nothing else', async () => {
    const scan = await scanOf(answer());
    const depop = depopOf(scan);
    expect(depop).toMatchObject({ status: 'checking', label: 'Checking Depop...' });
    expect(depop.read?.input).toMatchObject({
      version: 1,
      marketplace: 'depop',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        productTypes: ['jeans'],
        typeWords: ['jeans'],
      },
    });
    // Every marketplace with a reader gets a row, in the card's order.
    expect(scan.comparisons?.map((one) => one.marketplace)).toEqual([
      'depop',
      'ebay',
      'poshmark',
      'mercari',
      'vinted',
    ]);
    const [row] = await reads();
    expect(row).toMatchObject({ status: 'pending', scan_id: scan.id, marketplace: 'depop' });
  });

  it('shows asking prices under their label, holds the AI guess to them, and replays', async () => {
    const scan = await scanOf(answer());
    const read = depopOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerAndPrice(scan.id, read.id, READ);
    const depop = depopOf(answered.body);
    expect(depop).toEqual({
      marketplace: 'depop',
      status: 'read',
      label: 'Depop: asking $15-$25, 6 like it for sale',
      asking: {
        count: 6,
        low: { amountCents: 1500, currency: 'USD' },
        median: { amountCents: 2000, currency: 'USD' },
        high: { amountCents: 2500, currency: 'USD' },
        label: ASKING_PRICES_LABEL,
      },
      supply: 40,
      cached: false,
      demand: {
        demand: 'steady',
        basedOn: 'Your 0 sales like it in the last 90 days; 40 for sale on Depop now',
      },
    });
    // The AI's $20-$40, scaled to $15-$30 by the default 75% (no sales of the household's
    // yet), is held to what close matches ask.
    expect(answered.body.call).toMatchObject({
      basis: 'ai_estimate',
      low: { amountCents: 1500 },
      high: { amountCents: 2500 },
    });
    expect(answered.body.call.signals).toContainEqual({
      kind: 'asking',
      label: 'Asking $15-$25 on Depop',
      basedOn: `${ASKING_PRICES_LABEL}: 6 like it for sale on Depop; the range is held to them`,
    });
    expect(claimsSoldData(depop.label)).toBe(false);
    const [row] = await reads();
    expect(row).toMatchObject({ status: 'read', for_sale_total: 40, read_ms: 900 });
    // An answer again changes nothing.
    const again = await answerRead(scan.id, read.id, { outcome: 'failed', ms: 5 });
    expect(again.status).toBe(200);
    expect(depopOf(again.body).status).toBe('read');
  });

  it('answers the same item from a read of the last day, without asking the phone again', async () => {
    const first = await scanOf(answer());
    const read = depopOf(first).read;
    if (read === undefined) throw new Error('no read');
    await answerRead(first.id, read.id, READ);
    const second = await scanOf(answer({ condition: 'pre_owned_excellent' }));
    expect(depopOf(second)).toMatchObject({ status: 'read', cached: true, supply: 40 });
    expect(depopOf(second).read).toBeUndefined();
    expect(await reads()).toHaveLength(1);
    // Another size is another search.
    expect(depopOf(await scanOf(answer({ sizeLabel: '30' }))).status).toBe('checking');
  });

  it('pauses Depop for the day at a check, and for an hour when asked to slow down', async () => {
    const scan = await scanOf(answer());
    const read = depopOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerRead(scan.id, read.id, {
      outcome: 'check',
      ms: 1200,
      message: 'the page showed a bot check',
    });
    expect(depopOf(answered.body)).toEqual({
      marketplace: 'depop',
      status: 'paused',
      label: 'Depop prices paused today',
    });
    const next = await scanOf(answer({ line: '550' }));
    expect(depopOf(next)).toEqual({
      marketplace: 'depop',
      status: 'paused',
      label: 'Depop prices paused today',
    });
    expect((await reads()).map((row) => row.status)).toEqual(['check']);

    await api.db.deleteFrom('market_comparison').execute();
    const slow = await scanOf(answer({ line: '505' }));
    const slowRead = depopOf(slow).read;
    if (slowRead === undefined) throw new Error('no read');
    await answerRead(slow.id, slowRead.id, { outcome: 'rate_limited', ms: 300 });
    expect(depopOf(await scanOf(answer({ line: '517' }))).label).toBe(
      'Depop prices paused for an hour',
    );
    api.clock.now += 61 * 60 * 1000;
    expect(depopOf(await scanOf(answer({ line: '517' }))).status).toBe('checking');
  });

  it('hands the phone a read of eBay by brand and type words, the model, and the size', async () => {
    const scan = await scanOf(answer());
    const ebay = ebayOf(scan);
    expect(ebay).toMatchObject({ status: 'checking', label: 'Checking eBay...' });
    expect(ebay.read?.input).toMatchObject({
      version: 1,
      marketplace: 'ebay',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        // eBay's results name no category: a listing's title must name the type.
        productTypes: [],
        typeWords: ['jeans'],
      },
    });
  });

  it("rests the call on eBay's sold listings, under their label, with eBay's sold pace", async () => {
    const scan = await scanOf(answer({ line: '501', sizeLabel: '32x30' }));
    const read = ebayOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerAndPrice(scan.id, read.id, EBAY_READ);
    const ebay = ebayOf(answered.body);
    expect(ebay).toEqual({
      marketplace: 'ebay',
      status: 'read',
      label: 'eBay: sold $18-$30, 9 like it in the last 14 days',
      asking: {
        count: 4,
        low: { amountCents: 2500, currency: 'USD' },
        median: { amountCents: 2900, currency: 'USD' },
        high: { amountCents: 3500, currency: 'USD' },
        label: ASKING_PRICES_LABEL,
      },
      sold: {
        count: 9,
        low: { amountCents: 1800, currency: 'USD' },
        median: { amountCents: 2400, currency: 'USD' },
        high: { amountCents: 3000, currency: 'USD' },
        windowDays: 14,
        label: marketSoldLabel('eBay'),
      },
      supply: 320,
      cached: false,
      demand: {
        demand: 'strong',
        label: 'Sells fast on eBay',
        basedOn: 'Sold listings on eBay: 410 in the last 90 days; 320 for sale now',
      },
    });
    // No sales of the household's own like it: the call rests on eBay's sold listings.
    expect(answered.body.call).toMatchObject({
      call: 'buy',
      confidence: 'medium',
      basis: 'market_sold',
      basedOn: 'Sold listings on eBay: 9 like it in the last 14 days',
      low: { amountCents: 1800 },
      high: { amountCents: 3000 },
    });
    expect(answered.body.call.signals).toContainEqual({
      kind: 'demand',
      label: 'Sells fast on eBay',
      basedOn: 'Sold listings on eBay: 410 in the last 90 days; 320 for sale now',
    });
    const [row] = await reads('ebay');
    expect(row).toMatchObject({ status: 'read', for_sale_total: 320, sold_total: 410 });
    // The same search again is answered from the read, sold listings and pace included.
    const again = await scanOf(
      answer({ line: '501', sizeLabel: '32x30', condition: 'new_without_tags' }),
    );
    // Held while the web research runs, with no price but the count of what is for sale.
    expect(ebayOf(again)).toEqual({
      marketplace: 'ebay',
      status: 'read',
      label: 'Checked eBay',
      supply: 320,
      cached: true,
    });
    const pricedAgain = (await api.call('researchScan', { token, params: { scanId: again.id } }))
      .body;
    expect(ebayOf(pricedAgain)).toMatchObject({ status: 'read', cached: true, sold: { count: 9 } });
    expect(pricedAgain.call).toMatchObject({ basis: 'market_sold' });
  });

  it('shows eBay asking prices alone when no close match sold, and says when none match', async () => {
    const scan = await scanOf(answer({ line: '505' }));
    const read = ebayOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const { level, forSale } = EBAY_READ.stats;
    const answered = await answerAndPrice(scan.id, read.id, {
      ...EBAY_READ,
      stats: { level, forSale, read: { sold: 12, forSale: 40 } },
    });
    expect(ebayOf(answered.body)).toMatchObject({
      status: 'read',
      label: 'eBay: asking $25-$35, 4 like it for sale',
    });
    expect(ebayOf(answered.body).sold).toBeUndefined();
    expect(answered.body.call.basis).toBe('ai_estimate');

    const none = await scanOf(answer({ line: '569' }));
    const noneRead = ebayOf(none).read;
    if (noneRead === undefined) throw new Error('no read');
    const empty = await answerRead(none.id, noneRead.id, {
      outcome: 'read',
      // Nothing matched: the phone sends no level.
      stats: { read: { sold: 50, forSale: 50 } },
      forSaleTotal: 900,
      soldTotal: 700,
      ms: 2100,
    });
    expect(ebayOf(empty.body)).toMatchObject({
      status: 'not_enough',
      label: 'Not enough similar listings on eBay',
    });
  });

  it('says nothing of sold data where eBay gave no count, on a row of asking prices', async () => {
    const scan = await scanOf(answer({ line: '511' }));
    const read = ebayOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const { level, forSale } = EBAY_READ.stats;
    const answered = await answerAndPrice(scan.id, read.id, {
      outcome: 'read',
      stats: { level, forSale, read: { sold: 0, forSale: 40 } },
      forSaleTotal: 320,
      ms: 2000,
    });
    // The label guard holds the whole answer: a row of asking prices never says "sold".
    expect(answered.status).toBe(200);
    expect(ebayOf(answered.body).demand).toEqual({
      demand: 'unknown',
      basedOn: 'eBay gave no count of its sales',
    });
  });

  it("hands the phone a read of Poshmark by brand, Poshmark's department and category, model, and size", async () => {
    const scan = await scanOf(answer());
    expect(poshmarkOf(scan)).toMatchObject({ status: 'checking', label: 'Checking Poshmark...' });
    expect(poshmarkOf(scan).read?.input).toMatchObject({
      version: 1,
      marketplace: 'poshmark',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        productTypes: ['Women/Jeans'],
        typeWords: ['jeans'],
      },
    });
  });

  it("rests the call on Poshmark's sold listings, under their label, with its recent sold pace", async () => {
    const scan = await scanOf(answer());
    const read = poshmarkOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerAndPrice(scan.id, read.id, POSHMARK_READ);
    const pace = 'Sold listings on Poshmark: 44 like it in the last 42 days; 97,581 for sale now';
    expect(poshmarkOf(answered.body)).toEqual({
      marketplace: 'poshmark',
      status: 'read',
      label: 'Poshmark: sold $18-$34, 44 like it in the last 42 days',
      asking: {
        count: 41,
        low: { amountCents: 2300, currency: 'USD' },
        median: { amountCents: 3000, currency: 'USD' },
        high: { amountCents: 4000, currency: 'USD' },
        label: ASKING_PRICES_LABEL,
      },
      sold: {
        count: 44,
        low: { amountCents: 1800, currency: 'USD' },
        median: { amountCents: 2350, currency: 'USD' },
        high: { amountCents: 3400, currency: 'USD' },
        windowDays: 42,
        label: marketSoldLabel('Poshmark'),
      },
      supply: 97_581,
      cached: false,
      demand: { demand: 'strong', label: 'Sells fast on Poshmark', basedOn: pace },
    });
    // No sales of the household's own like it: the call rests on Poshmark's sold listings.
    expect(answered.body.call).toMatchObject({
      basis: 'market_sold',
      basedOn: 'Sold listings on Poshmark: 44 like it in the last 42 days',
      low: { amountCents: 1800 },
      high: { amountCents: 3400 },
    });
    expect(answered.body.call.signals).toContainEqual({
      kind: 'demand',
      label: 'Sells fast on Poshmark',
      basedOn: pace,
    });
    const [row] = await reads('poshmark');
    expect(row).toMatchObject({ status: 'read', for_sale_total: 97_581, sold_total: null });
    // The same search again is answered from the read, its pace included.
    const again = await scanOf(answer({ condition: 'new_without_tags' }));
    const pricedAgain = (await api.call('researchScan', { token, params: { scanId: again.id } }))
      .body;
    expect(poshmarkOf(pricedAgain)).toMatchObject({
      status: 'read',
      cached: true,
      sold: { count: 44 },
      demand: { demand: 'strong' },
    });
  });

  it('calls Poshmark slow when few close matches sold lately while many are for sale', async () => {
    const scan = await scanOf(answer());
    const read = poshmarkOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerAndPrice(scan.id, read.id, {
      ...POSHMARK_READ,
      stats: {
        ...POSHMARK_READ.stats,
        sold: { count: 3, lowCents: 1500, medianCents: 1800, highCents: 2200, windowDays: 90 },
      },
    });
    expect(poshmarkOf(answered.body).demand).toEqual({
      demand: 'crowded',
      label: 'Slow on Poshmark',
      basedOn: 'Sold listings on Poshmark: 3 like it in the last 90 days; 97,581 for sale now',
    });
    // Too few sold to rest the call on, and a slow search keeps it from high confidence.
    expect(answered.body.call.basis).not.toBe('market_sold');
    expect(answered.body.call.confidence).not.toBe('high');
  });

  it('hands the phone a read of Mercari by brand and type words, the model, and the size', async () => {
    const scan = await scanOf(answer());
    const mercari = mercariOf(scan);
    expect(mercari).toMatchObject({ status: 'checking', label: 'Checking Mercari...' });
    expect(mercari.read?.input).toMatchObject({
      version: 1,
      marketplace: 'mercari',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        // Mercari's cards name no category: a listing's name must name the type.
        productTypes: [],
        typeWords: ['jeans'],
      },
    });
    const [row] = await reads('mercari');
    expect(row).toMatchObject({ status: 'pending', scan_id: scan.id, marketplace: 'mercari' });
  });

  it("rests the call on Mercari's sold listings, with how many of its latest sales were lately", async () => {
    const scan = await scanOf(answer({ line: '501', sizeLabel: '32' }));
    const read = mercariOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerAndPrice(scan.id, read.id, MERCARI_READ);
    const pace = 'Sold listings on Mercari: 24 of the latest 30 sold in the last 30 days';
    expect(mercariOf(answered.body)).toEqual({
      marketplace: 'mercari',
      status: 'read',
      label: 'Mercari: sold $20-$28, 7 like it in the last 21 days',
      sold: {
        count: 7,
        low: { amountCents: 2000, currency: 'USD' },
        median: { amountCents: 2400, currency: 'USD' },
        high: { amountCents: 2800, currency: 'USD' },
        windowDays: 21,
        label: marketSoldLabel('Mercari'),
      },
      supply: 1400,
      cached: false,
      demand: { demand: 'strong', label: 'Sells fast on Mercari', basedOn: pace },
    });
    // No sales of the household's own like it: the call rests on Mercari's sold listings.
    expect(answered.body.call).toMatchObject({
      call: 'buy',
      basis: 'market_sold',
      basedOn: 'Sold listings on Mercari: 7 like it in the last 21 days',
      low: { amountCents: 2000 },
      high: { amountCents: 2800 },
    });
    expect(answered.body.call.signals).toContainEqual({
      kind: 'demand',
      label: 'Sells fast on Mercari',
      basedOn: pace,
    });
    const [row] = await reads('mercari');
    expect(row).toMatchObject({ status: 'read', for_sale_total: 1400, sold_total: 24 });
    // The same search again is answered from the read, its pace included.
    const again = await scanOf(
      answer({ line: '501', sizeLabel: '32', condition: 'pre_owned_excellent' }),
    );
    const pricedAgain = (await api.call('researchScan', { token, params: { scanId: again.id } }))
      .body;
    expect(mercariOf(pricedAgain)).toMatchObject({
      status: 'read',
      cached: true,
      sold: { count: 7 },
      demand: { demand: 'strong' },
    });
  });

  it('keeps a slow Mercari from a high-confidence call, and says nothing without its dates', async () => {
    const slow = await scanOf(answer({ line: '501', sizeLabel: '30' }));
    const slowRead = mercariOf(slow).read;
    if (slowRead === undefined) throw new Error('no read');
    const answered = await answerAndPrice(slow.id, slowRead.id, { ...MERCARI_READ, soldTotal: 3 });
    expect(mercariOf(answered.body).demand).toEqual({
      demand: 'crowded',
      label: 'Slow on Mercari',
      basedOn: 'Sold listings on Mercari: 3 of the latest 30 sold in the last 30 days',
    });
    expect(answered.body.call.confidence).not.toBe('high');

    // A page that dated none of its sales: the sold prices still show, the pace says why not.
    const undated = await scanOf(answer({ line: '505' }));
    const undatedRead = mercariOf(undated).read;
    if (undatedRead === undefined) throw new Error('no read');
    const plain = await answerAndPrice(undated.id, undatedRead.id, {
      outcome: 'read',
      stats: {
        ...MERCARI_READ.stats,
        sold: { count: 7, lowCents: 2000, medianCents: 2400, highCents: 2800 },
      },
      ms: 2900,
    });
    expect(plain.status).toBe(200);
    expect(mercariOf(plain.body)).toMatchObject({
      status: 'read',
      label: 'Mercari: sold $20-$28, 7 like it',
      demand: { demand: 'unknown', basedOn: 'Mercari gave no dates for its latest sales' },
    });
  });

  it("saves the last of Mercari's hour for items the AI prices at $25 or more", async () => {
    const { after } = COMPARISON_LIMITS.mercari.saveForPricier ?? { after: 0 };
    await api.db
      .insertInto('market_comparison')
      .values(
        Array.from({ length: after }, (_, index) => ({
          account_id: tenant.accountId,
          marketplace: 'mercari' as const,
          query_key: index.toString(16).padStart(64, '0'),
          query: { words: 'x' } as never,
          created_at: new Date(api.clock.now - 60_000),
        })),
      )
      .execute();
    const cheap = answer({ priceEstimate: { lowCents: 800, midCents: 1200, highCents: 1800 } });
    expect(mercariOf(await scanOf(cheap))).toEqual({
      marketplace: 'mercari',
      status: 'limit',
      label: 'Not checked: Mercari limit for this hour',
    });
    expect(mercariOf(await scanOf(answer())).status).toBe('checking');
  });

  it("saves the last of eBay's hour for items the AI prices at $25 or more", async () => {
    const { after } = COMPARISON_LIMITS.ebay.saveForPricier ?? { after: 0 };
    await api.db
      .insertInto('market_comparison')
      .values(
        Array.from({ length: after }, (_, index) => ({
          account_id: tenant.accountId,
          marketplace: 'ebay' as const,
          query_key: index.toString(16).padStart(64, '0'),
          query: { words: 'x' } as never,
          created_at: new Date(api.clock.now - 60_000),
        })),
      )
      .execute();
    const cheap = answer({ priceEstimate: { lowCents: 800, midCents: 1200, highCents: 1800 } });
    expect(ebayOf(await scanOf(cheap))).toEqual({
      marketplace: 'ebay',
      status: 'limit',
      label: 'Not checked: eBay limit for this hour',
    });
    expect(ebayOf(await scanOf(answer())).status).toBe('checking');
  });

  it('hands the phone a read of Vinted by brand and type words, the model, and the size', async () => {
    const scan = await scanOf(answer());
    const vinted = vintedOf(scan);
    expect(vinted).toMatchObject({ status: 'checking', label: 'Checking Vinted...' });
    expect(vinted.read?.input).toMatchObject({
      version: 1,
      marketplace: 'vinted',
      query: {
        words: 'levis 501 jeans',
        brand: "Levi's",
        model: '501',
        sizeLabel: '28',
        // Vinted's item boxes name no category: a listing's title must name the type.
        productTypes: [],
        typeWords: ['jeans'],
      },
    });
    const [row] = await reads('vinted');
    expect(row).toMatchObject({ status: 'pending', scan_id: scan.id, marketplace: 'vinted' });
  });

  it("shows Vinted's asking prices under their label, never as sold, with the household's own Vinted sales as the sold side", async () => {
    await soldOnVinted(2600);
    await soldOnVinted(2900);
    const scan = await scanOf(answer());
    const read = vintedOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerAndPrice(scan.id, read.id, VINTED_READ);
    const vinted = vintedOf(answered.body);
    expect(vinted).toEqual({
      marketplace: 'vinted',
      status: 'read',
      label: 'Vinted: asking $25-$30, 5 like it for sale',
      asking: {
        count: 5,
        low: { amountCents: 2500, currency: 'USD' },
        median: { amountCents: 2800, currency: 'USD' },
        high: { amountCents: 3000, currency: 'USD' },
        label: ASKING_PRICES_LABEL,
      },
      supply: 500,
      cached: false,
      demand: {
        demand: 'steady',
        basedOn: 'Your 2 sales like it in the last 90 days; 500 for sale on Vinted now',
      },
    });
    expect(claimsSoldData(vinted.label)).toBe(false);
    expect(vinted.sold).toBeUndefined();
    // The sold side is the household's own Vinted sales.
    expect(answered.body.ownSales.map((line) => [line.marketplace, line.soldCount])).toEqual([
      ['vinted', 2],
    ]);
    const [row] = await reads('vinted');
    expect(row).toMatchObject({ status: 'read', for_sale_total: 500, sold_total: null });
    // The other cases count no sales of the household's.
    await api.db.deleteFrom('sale_item').where('marketplace', '=', 'vinted').execute();
    await api.db.deleteFrom('sale').where('marketplace', '=', 'vinted').execute();
  });

  it('pauses Vinted for the day at a check', async () => {
    const scan = await scanOf(answer());
    const read = vintedOf(scan).read;
    if (read === undefined) throw new Error('no read');
    await answerRead(scan.id, read.id, {
      outcome: 'check',
      ms: 800,
      message: 'the page showed a CAPTCHA',
    });
    expect(vintedOf(await scanOf(answer({ line: '550' })))).toEqual({
      marketplace: 'vinted',
      status: 'paused',
      label: 'Vinted prices paused today',
    });
  });

  it("keeps Vinted's comparisons hidden from a seller until they pass live", () => {
    useMarketplaceFeatures('verified');
    expect(isFeatureOn('vinted', 'market_comps', SELLER_FEATURES)).toBe(false);
    // The owner's Test mode reads them, for the live test on the phone.
    expect(isFeatureOn('vinted', 'market_comps', { testMode: true })).toBe(true);
  });

  it("stops at the hour's budget", async () => {
    const limit = COMPARISON_LIMITS.depop.perHour;
    await api.db
      .insertInto('market_comparison')
      .values(
        Array.from({ length: limit }, (_, index) => ({
          account_id: tenant.accountId,
          marketplace: 'depop' as const,
          query_key: index.toString(16).padStart(64, '0'),
          query: { words: 'x' } as never,
          created_at: new Date(api.clock.now - 60_000),
        })),
      )
      .execute();
    expect(depopOf(await scanOf(answer()))).toEqual({
      marketplace: 'depop',
      status: 'limit',
      label: 'Not checked: Depop limit for this hour',
    });
  });

  it('searches nothing without a brand, and says when too few listings match', async () => {
    expect(depopOf(await scanOf(answer({ brand: '' })))).toEqual({
      marketplace: 'depop',
      status: 'not_enough',
      label: 'Not enough to search Depop for',
    });
    const scan = await scanOf(answer({ line: '569' }));
    const read = depopOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const thin = await answerRead(scan.id, read.id, {
      ...READ,
      stats: { ...READ.stats, forSale: { ...READ.stats.forSale, count: 2 } },
    });
    expect(depopOf(thin.body)).toMatchObject({
      status: 'not_enough',
      label: 'Not enough similar listings on Depop',
    });
    expect(thin.body.call.signals.map((signal) => signal.kind)).not.toContain('asking');
  });

  it('keeps a comparison the phone answered when the web research comes in after it', async () => {
    const item = answer({ line: '517', era: 'current' });
    const key = itemResearchKey({
      brand: "Levi's",
      category: 'clothing/bottoms/jeans',
      line: '517',
      styleNumber: null,
      era: 'current',
    });
    if (key === undefined) throw new Error('no research key');
    api.aiControls.fixtures[sha256Hex(key)] = {
      outputs: {
        [SCAN_RESEARCH_OUTPUT_NAME]: {
          retail: { lowCents: 0, highCents: 0, sourceUrls: [], models: [] },
          resale: {
            lowCents: 3_000,
            highCents: 5_000,
            sourceUrls: ['https://poshmark.com/brand/Levis-517'],
          },
          reputation: 'strong',
          summary: 'Used ones ask $30-$50 on Poshmark.',
        },
      },
      webSources: [{ url: 'https://poshmark.com/brand/Levis-517', title: 'Poshmark' }],
      usage: { webSearches: 1 },
    };
    const scan = await scanOf(item);
    const read = depopOf(scan).read;
    if (read === undefined) throw new Error('no read');
    await answerRead(scan.id, read.id, READ);
    const researched = await api.call('researchScan', { token, params: { scanId: scan.id } });
    expect(researched.status).toBe(200);
    expect(researched.body.research?.status).toBe('found');
    expect(depopOf(researched.body)).toMatchObject({ status: 'read', supply: 40 });
    // The web's range, held to what close matches ask on Depop.
    expect(researched.body.call).toMatchObject({ basis: 'web_info', high: { amountCents: 2500 } });
  });

  it('shows a read that failed, refuses others and malformed answers', async () => {
    const scan = await scanOf(answer({ line: '511' }));
    const read = depopOf(scan).read;
    if (read === undefined) throw new Error('no read');
    expect((await answerRead(scan.id, read.id, READ, otherToken)).status).toBe(404);
    expect((await answerRead(scan.id, '0193a000-0000-7000-8000-000000000009', READ)).status).toBe(
      404,
    );
    const listing = {
      ...READ,
      stats: { ...READ.stats, listings: [{ seller: 'someone', priceCents: 1500 }] },
    };
    expect((await answerRead(scan.id, read.id, listing)).status).toBe(422);
    expect((await answerRead(scan.id, read.id, { outcome: 'guessed', ms: 1 })).status).toBe(422);
    const unordered = {
      ...READ,
      stats: {
        ...READ.stats,
        forSale: { count: 6, lowCents: 3000, medianCents: 2000, highCents: 2500 },
      },
    };
    expect((await answerRead(scan.id, read.id, unordered)).status).toBe(422);
    const overcounted = { ...READ, stats: { ...READ.stats, read: { sold: 0, forSale: 3 } } };
    expect((await answerRead(scan.id, read.id, overcounted)).status).toBe(422);
    const failed = await answerRead(scan.id, read.id, {
      outcome: 'failed',
      ms: 30000,
      message: 'timeout',
    });
    expect(depopOf(failed.body)).toEqual({
      marketplace: 'depop',
      status: 'failed',
      label: "Couldn't check Depop",
    });
  });
});
