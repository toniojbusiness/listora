import { SCAN_OUTPUT_NAME, SCAN_RESEARCH_OUTPUT_NAME } from '@listora/analysis';
import { useMarketplaceFeatures } from '@listora/marketplaces';
import { claimsSoldData } from '@listora/pricing';
import { itemResearchKey } from '@listora/sourcing';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

// Invented sellers, items, and pages; no real shop's data.
const OWNER = 'pricing.owner@example.com';
/** The prices' wait in these tests: short, so a source that never answers ends it quickly. */
const WAIT_MS = 1_500;

const RETAIL = { url: 'https://www.wrenfield.example/coats/harbor', title: 'Harbor coat' };
const RESALE = [
  { url: 'https://poshmark.com/brand/Wrenfield-coats', title: 'Poshmark' },
  { url: 'https://www.ebay.com/b/Wrenfield-coats/1', title: 'eBay' },
];
const FOUND = {
  retail: { lowCents: 24_000, highCents: 24_000, sourceUrls: [RETAIL.url], models: ['Harbor'] },
  resale: { lowCents: 6_000, highCents: 9_000, sourceUrls: RESALE.map((page) => page.url) },
  reputation: 'strong',
  summary: 'Wrenfield lists the Harbor at $240; used ones ask $60-$90 on Poshmark and eBay.',
};

/** The AI's answer for a scan, in the model's flat shape: an invented brand's wool coat. */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    brand: 'Wrenfield',
    item: 'navy wool overcoat',
    line: 'Harbor',
    styleNumber: '',
    era: 'current',
    material: 'wool',
    category: 'clothing/outerwear/coats',
    department: 'men',
    sizeLabel: 'L',
    condition: 'pre_owned_good',
    identityConfidence: 0.9,
    priceEstimate: { lowCents: 4000, midCents: 6000, highCents: 8000 },
    retailPriceCents: 0,
    style: '',
    searchWords: 'wrenfield harbor coat',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    ...overrides,
  };
}

/** Depop's close matches asking $50 to $70. */
const DEPOP_READ = {
  outcome: 'read' as const,
  stats: {
    level: 'model' as const,
    forSale: { count: 6, lowCents: 5000, medianCents: 6000, highCents: 7000 },
    read: { sold: 0, forSale: 24 },
  },
  forSaleTotal: 30,
  ms: 900,
};

describe('a scan’s prices wait for what they rest on (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  /** The same API with no marketplace comparisons handed out, as with `MARKET_COMPARISONS=off`. */
  let plain: { api: TestApi; token: string };
  let seed = 0;

  beforeAll(async () => {
    api = await createTestApi('scan_pricing', { scanPriceWaitMs: WAIT_MS });
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    const plainApi = await createTestApi('scan_pricing_plain', {
      scanPriceWaitMs: WAIT_MS,
      marketComparisons: false,
    });
    plain = { api: plainApi, token: await plainApi.signIn(OWNER) };
  });

  afterEach(async () => {
    useMarketplaceFeatures('all');
    await api.db.deleteFrom('market_comparison').execute();
  });

  afterAll(async () => {
    await Promise.all([api.close(), plain.api.close()]);
  });

  /** The fake web's answer for an item's lookup, keyed as the research keys it. */
  function web(item: ReturnType<typeof answer>, on: TestApi = api) {
    const key = itemResearchKey({
      brand: item.brand,
      category: item.category,
      line: item.line === '' ? null : item.line,
      styleNumber: item.styleNumber === '' ? null : item.styleNumber,
      era: item.era === '' ? null : item.era,
    });
    if (key === undefined) throw new Error('expected a research key');
    on.aiControls.fixtures[sha256Hex(key)] = {
      outputs: { [SCAN_RESEARCH_OUTPUT_NAME]: FOUND },
      webSources: [RETAIL, ...RESALE],
      usage: { webSearches: 2 },
    };
  }

  async function scanOf(output: ReturnType<typeof answer>, side = { api, token }) {
    seed += 1;
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: seed % 256, g: 7, b: 90 } },
      })
        .jpeg()
        .toBuffer(),
    );
    side.api.aiControls.fixtures[photoSetHash([sha256Hex(bytes)])] = {
      outputs: { [SCAN_OUTPUT_NAME]: output },
    };
    const run = await side.api.call('createSourcingRun', { token: side.token, body: {} });
    const response = await side.api.call('createScan', {
      token: side.token,
      body: {
        runId: run.body.id,
        images: [{ role: 'item', jpegBase64: Buffer.from(bytes).toString('base64') }],
      },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function lookups(): Promise<number> {
    const rows = await api.db
      .selectFrom('ai_usage_event')
      .select('id')
      .where('account_id', '=', tenant.accountId)
      .where('purpose', '=', 'thrift_scan_research')
      .execute();
    return rows.length;
  }

  async function storedResearch(scanId: string) {
    const row = await api.db
      .selectFrom('item_scan')
      .select(['research', 'research_started_at'])
      .where('id', '=', scanId)
      .executeTakeFirstOrThrow();
    return row;
  }

  async function priced(scanId: string, side = { api, token }) {
    const response = await side.api.call('researchScan', {
      token: side.token,
      params: { scanId },
    });
    expect(response.status).toBe(200);
    return response.body;
  }

  function comparison(scan: Awaited<ReturnType<typeof scanOf>>, marketplace: string) {
    const row = scan.comparisons?.find((one) => one.marketplace === marketplace);
    if (row?.read === undefined) throw new Error(`no ${marketplace} read`);
    return row.read.id;
  }

  async function answerRead(scanId: string, comparisonId: string, body: unknown) {
    const response = await api.call('saveScanComparison', {
      token,
      params: { scanId, comparisonId },
      body: body as never,
    });
    expect(response.status).toBe(200);
    return response.body;
  }

  it('looks the web up as soon as the read lands, before the app asks, and only once', async () => {
    const item = answer();
    web(item);
    const before = await lookups();
    const scan = await scanOf(item);
    expect(scan.call.call).toBe('checking');
    // Nobody asked: the lookup ran on its own, from the read.
    for (let tries = 0; (await storedResearch(scan.id)).research === null; tries += 1) {
      if (tries > 100) throw new Error('the research never came');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await storedResearch(scan.id)).research_started_at).not.toBeNull();
    // Asked twice at once (and the comparisons left to time out), it is answered from the
    // lookup that ran, which no ask repeats.
    const [first, second] = await Promise.all([priced(scan.id), priced(scan.id)]);
    expect(first.pricing?.status).toBe('ready');
    expect(first.research?.status).toBe('found');
    expect(second).toEqual(first);
    expect(await lookups()).toBe(before + 1);
  });

  it('holds every price until each comparison is in, then shows them with what they rest on', async () => {
    const item = answer({ line: 'Dock' });
    web(item);
    const scan = await scanOf(item);
    expect(scan.pricing).toMatchObject({
      status: 'checking',
      waitingOn: ['web', 'depop', 'ebay', 'poshmark', 'mercari'],
    });

    // Depop answers while the others are out: its row says it was checked, with no prices.
    const afterDepop = await answerRead(scan.id, comparison(scan, 'depop'), DEPOP_READ);
    expect(afterDepop.call.call).toBe('checking');
    expect(afterDepop.comparisons?.find((one) => one.marketplace === 'depop')).toEqual({
      marketplace: 'depop',
      status: 'read',
      label: 'Checked Depop',
      supply: 30,
      cached: false,
    });
    expect(afterDepop.call.prices).toBeUndefined();

    // eBay, Poshmark, and Mercari could not be read; the web came back: the prices are in.
    await answerRead(scan.id, comparison(scan, 'ebay'), { outcome: 'failed', ms: 4 });
    await answerRead(scan.id, comparison(scan, 'poshmark'), { outcome: 'failed', ms: 4 });
    await answerRead(scan.id, comparison(scan, 'mercari'), { outcome: 'failed', ms: 4 });
    const body = await priced(scan.id);
    expect(body.pricing).toEqual({
      status: 'ready',
      label:
        "Checked your sales, the web, and Depop. Couldn't check eBay. Couldn't check Poshmark. Couldn't check Mercari.",
      missing: [
        { source: 'ebay', label: "Couldn't check eBay" },
        { source: 'poshmark', label: "Couldn't check Poshmark" },
        { source: 'mercari', label: "Couldn't check Mercari" },
      ],
      waitUntil: expect.any(String) as string,
    });
    expect(body.call.prices).toBeDefined();
    expect(['buy', 'your_call', 'skip']).toContain(body.call.call);
    expect(body.call.why).toBeDefined();
    expect(body.realityCheck?.map((line) => line.kind)).toEqual([
      'asking',
      'web',
      'retail',
      'cost',
      'missing',
      'missing',
      'missing',
    ]);
    for (const line of body.realityCheck ?? []) expect(claimsSoldData(line.text)).toBe(false);
  });

  it('shows the prices from what came back once the wait ends, never raising the confidence', async () => {
    const item = answer({ line: 'Pier' });
    web(item);
    const scan = await scanOf(item);
    const started = Date.now();
    // No phone answers: the wait ends, and the call rests on the web alone.
    const body = await priced(scan.id);
    expect(Date.now() - started).toBeLessThan(WAIT_MS + 1_000);
    expect(body.pricing?.missing).toEqual([
      { source: 'depop', label: "Couldn't check Depop in time" },
      { source: 'ebay', label: "Couldn't check eBay in time" },
      { source: 'poshmark', label: "Couldn't check Poshmark in time" },
      { source: 'mercari', label: "Couldn't check Mercari in time" },
    ]);
    expect(body.call.signals.filter((signal) => signal.kind === 'missing')).toHaveLength(4);
    // The same item with no comparisons on makes the same call: a missing source adds nothing.
    const alongside = answer({ line: 'Pier' });
    web(alongside, plain.api);
    const alone = await priced((await scanOf(alongside, plain)).id, plain);
    expect(alone.pricing?.missing).toBeUndefined();
    expect(body.call).toMatchObject({
      call: alone.call.call,
      confidence: alone.call.confidence,
      basis: alone.call.basis,
    });

    // A late answer still comes in, and the call is made again with it.
    const late = await answerRead(scan.id, comparison(scan, 'depop'), DEPOP_READ);
    expect(late.pricing?.status).toBe('ready');
    expect(late.comparisons?.find((one) => one.marketplace === 'depop')?.asking?.count).toBe(6);
  });

  it('names the web when its lookup fails, and looks it up again when asked', async () => {
    // No fixture for the lookup: it fails.
    const item = answer({ line: 'Quay' });
    const scan = await scanOf(item, plain);
    const failed = await priced(scan.id, plain);
    expect(failed.pricing?.missing).toEqual([{ source: 'web', label: "Couldn't check the web" }]);
    expect(failed.research).toBeUndefined();
    expect(failed.call.basis).toBe('ai_estimate');
    // Asked again with the web back, the lookup runs again and the prices rest on it.
    web(item, plain.api);
    const again = await priced(scan.id, plain);
    expect(again.pricing?.missing).toBeUndefined();
    expect(again.research?.status).toBe('found');
    expect(again.call.basis).toBe('web_info');
  });

  it('prices a read without a brand at once, from the household’s sales and the AI estimate', async () => {
    const before = await lookups();
    const scan = await scanOf(answer({ brand: '', line: '' }));
    expect(scan.pricing).toMatchObject({ status: 'ready', label: 'Checked your sales.' });
    expect(scan.call.basis).toBe('ai_estimate');
    expect(scan.call.prices).toBeDefined();
    expect(await lookups()).toBe(before);
  });
});
