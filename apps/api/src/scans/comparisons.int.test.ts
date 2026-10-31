import { SCAN_OUTPUT_NAME, SCAN_RESEARCH_OUTPUT_NAME } from '@listora/analysis';
import { useMarketplaceFeatures } from '@listora/marketplaces';
import { ASKING_PRICES_LABEL, claimsSoldData } from '@listora/pricing';
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

  async function answerRead(scanId: string, comparisonId: string, body: unknown, as = token) {
    return api.call('saveScanComparison', {
      token: as,
      params: { scanId, comparisonId },
      body: body as never,
    });
  }

  async function reads() {
    return api.db
      .selectFrom('market_comparison')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
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
    // Only Depop has a reader: no other marketplace gets a row.
    expect(scan.comparisons?.map((one) => one.marketplace)).toEqual(['depop']);
    const [row] = await reads();
    expect(row).toMatchObject({ status: 'pending', scan_id: scan.id, marketplace: 'depop' });
  });

  it('shows asking prices under their label, holds the AI guess to them, and replays', async () => {
    const scan = await scanOf(answer());
    const read = depopOf(scan).read;
    if (read === undefined) throw new Error('no read');
    const answered = await answerRead(scan.id, read.id, READ);
    expect(answered.status).toBe(200);
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
    // The AI's $20-$40 is held to what close matches ask.
    expect(answered.body.call).toMatchObject({
      basis: 'ai_estimate',
      low: { amountCents: 2000 },
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
