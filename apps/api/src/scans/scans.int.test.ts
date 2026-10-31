import { jsonb, type Marketplace } from '@listora/db';
import {
  SCAN_OUTPUT_NAME,
  SCAN_RESEARCH_OUTPUT_NAME,
  WEB_INFO_LABEL as ANALYSIS_WEB_INFO,
} from '@listora/analysis';
import { useMarketplaceFeatures } from '@listora/marketplaces';
import {
  AI_ESTIMATE_LABEL,
  claimsSoldData,
  DEPOP_SEARCH_LABEL,
  WEB_INFO_LABEL,
} from '@listora/pricing';
import { brandKey, itemResearchKey } from '@listora/sourcing';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

import { MAX_SCANS_PER_DAY } from './routes.ts';

// Invented sellers, sales, and items; no real shop's data.
const OWNER = 'scans.owner@example.com';
const OTHER = 'scans.other@example.com';
const LEGGINGS = 'clothing/bottoms/leggings';
const DAY_MS = 24 * 60 * 60 * 1000;
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

/** The AI's answer for a scan, in the model's flat shape. */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    brand: 'Lululemon',
    item: 'black high-rise leggings',
    line: 'Align',
    styleNumber: '',
    era: '',
    material: 'nylon',
    category: LEGGINGS,
    department: 'women',
    sizeLabel: '6',
    condition: 'pre_owned_good',
    identityConfidence: 0.9,
    priceEstimate: { lowCents: 2400, midCents: 3200, highCents: 4000 },
    retailPriceCents: 0,
    style: '',
    searchWords: 'lululemon align leggings',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    ...overrides,
  };
}

describe('the thrift scan (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let otherToken: string;
  let seed = 0;

  beforeAll(async () => {
    api = await createTestApi('scans');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    otherToken = await api.signIn(OTHER);
  });

  afterEach(() => {
    useMarketplaceFeatures('all');
    api.aiControls.killed = false;
  });

  afterAll(async () => {
    await api.close();
  });

  /** A small JPEG of its own color, as base64, with its photo-set hash as a scan's only image. */
  async function jpeg(width = 64, height = 48) {
    seed += 1;
    const bytes = new Uint8Array(
      await sharp({
        create: { width, height, channels: 3, background: { r: seed % 256, g: 40, b: 9 } },
      })
        .jpeg()
        .toBuffer(),
    );
    return { base64: Buffer.from(bytes).toString('base64'), sha256: sha256Hex(bytes) };
  }

  /** An image the fake AI answers `output` for. */
  async function scanImage(output: unknown) {
    const image = await jpeg();
    api.aiControls.fixtures[photoSetHash([image.sha256])] = {
      outputs: { [SCAN_OUTPUT_NAME]: output },
    };
    return image;
  }

  async function startRun(as = token, place?: string) {
    const response = await api.call('createSourcingRun', {
      token: as,
      body: place === undefined ? {} : { place },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function scan(runId: string, base64: string, extra: Record<string, unknown> = {}) {
    return api.call('createScan', {
      token,
      body: { runId, images: [{ role: 'item', jpegBase64: base64 }], ...extra },
    });
  }

  /** A sold item of the owner: a one-item sale on `marketplace`, three days back. */
  async function sell(marketplace: Marketplace, details: Record<string, unknown>, cents: number) {
    const item = await api.call('createItem', { token, body: { details } });
    const sale = await api.db
      .insertInto('sale')
      .values({
        account_id: tenant.accountId,
        marketplace,
        sold_at: new Date(api.clock.now - 3 * DAY_MS),
        detection_source: 'history',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await api.db
      .insertInto('sale_item')
      .values({
        account_id: tenant.accountId,
        sale_id: sale.id,
        marketplace,
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

  /** The account's metered scan calls so far. */
  async function scanCalls(accountId = tenant.accountId): Promise<number> {
    const rows = await api.db
      .selectFrom('ai_usage_event')
      .select('id')
      .where('account_id', '=', accountId)
      .where('purpose', '=', 'thrift_scan')
      .execute();
    return rows.length;
  }

  async function setTestMode(on: boolean) {
    await api.db
      .updateTable('account')
      .set({ test_mode: on })
      .where('id', '=', tenant.accountId)
      .execute();
  }

  it('is hidden from a seller until it passes live, and on in Test mode', async () => {
    useMarketplaceFeatures('verified');
    const refused = await api.call('createSourcingRun', { token, body: {} });
    expect(refused.status).toBe(404);
    expect(
      (
        await api.call('keepScan', {
          token,
          params: { scanId: '0193a000-0000-7000-8000-000000000001' },
        })
      ).status,
    ).toBe(404);
    await setTestMode(true);
    try {
      const run = await startRun(token, '  Goodwill   Outlet ');
      expect(run).toEqual({
        id: run.id,
        place: 'Goodwill Outlet',
        startedAt: run.startedAt,
        scanCount: 0,
        keptCount: 0,
      });
    } finally {
      await setTestMode(false);
    }
  });

  it("calls an item from the household's own sales, labels the AI estimate, and keeps no image", async () => {
    await sell('depop', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 2200);
    await sell('depop', { title: 'Align', brand: 'LULULEMON', category: LEGGINGS }, 2800);
    await sell('mercari', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 3000);
    // eBay's own sales show but never feed the call.
    await sell('ebay', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 9000);
    await sell('ebay', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 9900);
    const run = await startRun();
    const image = await scanImage(answer());
    const response = await scan(run.id, image.base64, {
      note: 'size six, no flaws',
      tagText: ['lululemon', '6'],
    });
    expect(response.status).toBe(201);
    const body = response.body;
    expect(body.identity).toEqual({
      item: 'black high-rise leggings',
      brand: 'Lululemon',
      model: 'Align',
      category: LEGGINGS,
      department: 'women',
      sizeLabel: '6',
      condition: 'pre_owned_good',
      confidence: 0.9,
    });
    expect(body.aiEstimate).toEqual({
      label: AI_ESTIMATE_LABEL,
      low: usd(2400),
      mid: usd(3200),
      high: usd(4000),
    });
    // Three sales on Depop and Mercari; the Depop fee table's payout of the low quartile.
    expect(body.call).toMatchObject({
      call: 'buy',
      label: 'Buy',
      confidence: 'medium',
      basis: 'own_history',
      basedOn: 'Your 3 sales like it',
      low: usd(2500),
      high: usd(2900),
      payoutMarketplace: 'depop',
      worthListing: usd(800),
    });
    expect(body.call.conservativePayout?.amountCents).toBeLessThan(2500);
    expect(
      body.ownSales.map((line) => [line.marketplace, line.soldCount, line.displayOnly]),
    ).toEqual([
      ['ebay', 2, true],
      ['depop', 2, false],
    ]);
    expect(body.ownSales[1]?.label).toBe(
      'Your sales of similar Lululemon items on Depop (last 365 days)',
    );
    expect(body.researchLinks[0]?.label).toBe(DEPOP_SEARCH_LABEL);
    expect(body.decision).toBe('undecided');
    // "Sold" only next to the household's own sales.
    expect(claimsSoldData(body.call.basedOn)).toBe(false);

    const row = await api.db
      .selectFrom('item_scan')
      .selectAll()
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(row.image_sha256).toBe(image.sha256);
    expect(row.call).toBe('buy');
    expect(row.read_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(row)).not.toContain(image.base64.slice(0, 40));
    const photos = await api.db
      .selectFrom('upload_file')
      .select('id')
      .where('account_id', '=', tenant.accountId)
      .execute();
    expect(photos).toEqual([]);
    const usage = await api.db
      .selectFrom('ai_usage_event')
      .select(['purpose', 'images'])
      .where('account_id', '=', tenant.accountId)
      .where('purpose', '=', 'thrift_scan')
      .execute();
    expect(usage).toEqual([{ purpose: 'thrift_scan', images: 1 }]);
    const after = await api.db
      .selectFrom('sourcing_run')
      .select(['scan_count', 'kept_count'])
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ scan_count: 1, kept_count: 0 });
  });

  it("warns of the household's unsold items like it, without moving the call", async () => {
    const run = await startRun();
    const image = await scanImage(answer());
    const before = await scan(run.id, image.base64);
    expect(before.body.call.signals.map((signal) => signal.kind)).not.toContain('unsold');

    for (const brand of ['Lululemon', 'LULULEMON']) {
      const item = await api.call('createItem', {
        token,
        body: { details: { title: 'Align', brand, category: LEGGINGS } },
      });
      await api.db
        .updateTable('inventory_item')
        .set({ status: brand === 'Lululemon' ? 'listed' : 'ready' })
        .where('id', '=', item.body.id)
        .execute();
    }
    // Another kind of the brand, and a sold one, are not like it.
    const tank = await api.call('createItem', {
      token,
      body: { details: { title: 'Tank', brand: 'Lululemon', category: 'clothing/tops/tank_tops' } },
    });
    await api.db
      .updateTable('inventory_item')
      .set({ status: 'listed' })
      .where('id', '=', tank.body.id)
      .execute();
    await sell('depop', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 2200);

    const again = await scan(run.id, (await scanImage(answer())).base64);
    expect(again.status).toBe(201);
    expect(again.body.call.call).toBe(before.body.call.call);
    expect(again.body.call.signals.find((signal) => signal.kind === 'unsold')).toEqual({
      kind: 'unsold',
      label: 'You have 2 like it unsold',
      basedOn: 'Your items of the same brand and kind in inventory, ready or listed',
    });
  });

  it('rests on the AI estimate alone at low confidence, and skips what pays out too little', async () => {
    const run = await startRun();
    const unknown = await scanImage(
      answer({ brand: 'Nobody Knows', category: 'clothing/tops/t_shirts' }),
    );
    const ai = (await scan(run.id, unknown.base64)).body;
    expect(ai.ownSales).toEqual([]);
    expect(ai.call).toMatchObject({
      call: 'your_call',
      confidence: 'low',
      basis: 'ai_estimate',
      basedOn: AI_ESTIMATE_LABEL,
    });
    const cheap = await scanImage(
      answer({
        brand: '',
        category: '',
        priceEstimate: { lowCents: 300, midCents: 400, highCents: 600 },
      }),
    );
    expect((await scan(run.id, cheap.base64)).body.call).toMatchObject({
      call: 'skip',
      confidence: 'low',
    });
    const nothing = await scanImage(
      answer({
        brand: '',
        category: '',
        priceEstimate: { lowCents: 0, midCents: 0, highCents: 0 },
      }),
    );
    const none = (await scan(run.id, nothing.base64)).body;
    expect(none.aiEstimate).toBeUndefined();
    expect(none.call).toMatchObject({
      call: 'your_call',
      basis: 'none',
      basedOn: 'Not enough to go on',
    });
  });

  it('refuses images that are not small JPEGs, an item first', async () => {
    const run = await startRun();
    const image = await jpeg();
    const big = await jpeg(1700, 40);
    const cases: [unknown[], string][] = [
      [[{ role: 'item', jpegBase64: 'not base64!' }], 'images[0].jpegBase64'],
      [
        [{ role: 'item', jpegBase64: Buffer.from('GIF89a....').toString('base64') }],
        'images[0].jpegBase64',
      ],
      [[{ role: 'item', jpegBase64: big.base64 }], 'images[0].jpegBase64'],
      [[{ role: 'tag', jpegBase64: image.base64 }], 'images[0].role'],
      [
        [
          { role: 'item', jpegBase64: image.base64 },
          { role: 'item', jpegBase64: image.base64 },
        ],
        'images',
      ],
    ];
    for (const [images, field] of cases) {
      const response = await api.call('createScan', { token, body: { runId: run.id, images } });
      expect(response.status, field).toBe(422);
      expect(response.error.fieldErrors?.map((error) => error.field)).toContain(field);
    }
    const scans = await api.db
      .selectFrom('item_scan')
      .select('id')
      .where('run_id', '=', run.id)
      .execute();
    expect(scans).toEqual([]);
  });

  it("refuses another account's run and an ended one", async () => {
    const theirs = await startRun(otherToken);
    const image = await scanImage(answer());
    expect((await scan(theirs.id, image.base64)).status).toBe(404);
    const run = await startRun();
    const ended = await api.call('endSourcingRun', { token, params: { runId: run.id } });
    expect(ended.status).toBe(200);
    expect(ended.body.endedAt).toBeDefined();
    const refused = await scan(run.id, image.base64);
    expect(refused.status).toBe(409);
    expect(refused.error.code).toBe('invalid_state_transition');
  });

  it('answers a failed read with Retry, and stores nothing', async () => {
    const run = await startRun();
    const broken = await scanImage(answer({ identityConfidence: 7 }));
    const before = await scanCalls();
    const failed = await scan(run.id, broken.base64);
    expect(failed.status).toBe(503);
    expect(failed.error).toMatchObject({ code: 'service_unavailable', retryable: true });
    // The answer that broke the schema was asked for once more, and both calls were metered.
    expect((await scanCalls()) - before).toBe(2);
    api.aiControls.killed = true;
    const paused = await scan(run.id, (await scanImage(answer())).base64);
    expect(paused.status).toBe(503);
    expect(paused.error.message).toContain('paused');
    const scans = await api.db
      .selectFrom('item_scan')
      .select('id')
      .where('run_id', '=', run.id)
      .execute();
    expect(scans).toEqual([]);
  });

  it('replays a retried scan without reading it again', async () => {
    const run = await startRun();
    const image = await scanImage(answer());
    const body = { runId: run.id, images: [{ role: 'item', jpegBase64: image.base64 }] };
    const before = await scanCalls();
    const first = await api.call('createScan', { token, body, idempotencyKey: 'scan-retry-0001' });
    const again = await api.call('createScan', { token, body, idempotencyKey: 'scan-retry-0001' });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((await scanCalls()) - before).toBe(1);
  });

  it('keeps a scan as one draft item with the read as AI details, however often it is kept', async () => {
    const run = await startRun();
    const image = await scanImage(answer({ item: 'Lululemon black align leggings' }));
    const scanned = (await scan(run.id, image.base64)).body;
    const kept = await api.call('keepScan', { token, params: { scanId: scanned.id } });
    expect(kept.status).toBe(201);
    expect(kept.body.status).toBe('draft');
    expect(kept.body.details).toMatchObject({
      title: 'Lululemon black align leggings',
      brand: 'Lululemon',
      category: LEGGINGS,
      department: 'women',
      sizeLabel: '6',
      condition: 'pre_owned_good',
    });
    expect(kept.body.fieldProvenance).toMatchObject({ title: 'ai', brand: 'ai', condition: 'ai' });
    // Kept again with a new key: the same item, never a second one.
    const again = await api.call('keepScan', { token, params: { scanId: scanned.id } });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(kept.body.id);
    const row = await api.db
      .selectFrom('item_scan')
      .select(['decision', 'item_id'])
      .where('id', '=', scanned.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ decision: 'kept', item_id: kept.body.id });
    const counts = await api.db
      .selectFrom('sourcing_run')
      .select(['scan_count', 'kept_count'])
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(counts).toEqual({ scan_count: 1, kept_count: 1 });
    // Another account cannot keep it.
    expect(
      (await api.call('keepScan', { token: otherToken, params: { scanId: scanned.id } })).status,
    ).toBe(404);
  });

  it('keeps no scan a later one replaced, nor one its ended run skipped', async () => {
    const run = await startRun();
    const first = (await scan(run.id, (await scanImage(answer())).base64)).body;
    const second = (
      await scan(run.id, (await scanImage(answer())).base64, {
        note: 'small stain on the knee',
        replacesScanId: first.id,
      })
    ).body;
    const replaced = await api.call('keepScan', { token, params: { scanId: first.id } });
    expect(replaced.status).toBe(409);
    const elsewhere = await startRun();
    const wrongRun = await scan(elsewhere.id, (await scanImage(answer())).base64, {
      replacesScanId: second.id,
    });
    expect(wrongRun.status).toBe(422);

    await api.call('endSourcingRun', { token, params: { runId: run.id } });
    const skipped = await api.call('keepScan', { token, params: { scanId: second.id } });
    expect(skipped.status).toBe(409);
    const decisions = await api.db
      .selectFrom('item_scan')
      .select(['id', 'decision'])
      .where('run_id', '=', run.id)
      .orderBy('created_at')
      .execute();
    expect(decisions.map((row) => row.decision)).toEqual(['replaced', 'skipped']);
  });

  it('stops at the daily scan limit before reading', async () => {
    const fresh = await api.signIn('scans.limit@example.com');
    const owner = await api.tenantOf('scans.limit@example.com');
    const run = (await api.call('createSourcingRun', { token: fresh, body: {} })).body;
    await api.db
      .insertInto('item_scan')
      .values(
        Array.from({ length: MAX_SCANS_PER_DAY }, () => ({
          account_id: owner.accountId,
          run_id: run.id,
          image_sha256: 'a'.repeat(64),
          image_count: 1,
          read: jsonb({}),
          call: 'skip' as const,
          confidence: 'low' as const,
          basis: 'none' as const,
          call_detail: jsonb({}),
          model: 'fake',
          ai_attempts: 1,
          cost_micros: 0,
          read_ms: 0,
        })),
      )
      .execute();
    const image = await scanImage(answer());
    const limited = await api.call('createScan', {
      token: fresh,
      body: { runId: run.id, images: [{ role: 'item', jpegBase64: image.base64 }] },
    });
    expect(limited.status).toBe(429);
    expect(limited.error.code).toBe('rate_limited');
    expect(await scanCalls(owner.accountId)).toBe(0);
  });

  describe('the web research', () => {
    const RETAIL = {
      url: 'https://www.levi.com/US/en_US/501-original-fit-jeans/p/005010114',
      title: '501',
    };
    const RESALE = [
      { url: 'https://poshmark.com/brand/Levis-501', title: 'Poshmark' },
      { url: 'https://www.ebay.com/b/Levis-501/1', title: 'eBay' },
    ];
    const JEANS = 'clothing/bottoms/jeans';
    const read = (overrides: Record<string, unknown> = {}) =>
      answer({
        brand: "Levi's",
        item: 'medium wash straight jeans',
        category: JEANS,
        line: '501',
        era: 'current',
        material: 'denim',
        ...overrides,
      });

    /** The fake web's answer for an item, keyed as the research keys it. */
    function web(item: Record<string, unknown>, research: Record<string, unknown>) {
      const text = (key: string) => ((item[key] as string) === '' ? null : (item[key] as string));
      const key =
        itemResearchKey({
          brand: item['brand'] as string,
          category: item['category'] as string,
          line: text('line'),
          styleNumber: text('styleNumber'),
          era: text('era'),
        }) ??
        `${brandKey(item['brand'] as string) ?? ''}|${item['category'] as string}|${(item['item'] as string).toLowerCase()}`;
      api.aiControls.fixtures[sha256Hex(key)] = {
        outputs: { [SCAN_RESEARCH_OUTPUT_NAME]: research },
        webSources: [RETAIL, ...RESALE],
        usage: { webSearches: 2 },
      };
    }
    const found = {
      retail: {
        lowCents: 9_800,
        highCents: 9_800,
        sourceUrls: [RETAIL.url],
        models: ['501 Original'],
      },
      resale: { lowCents: 3_000, highCents: 5_000, sourceUrls: RESALE.map((page) => page.url) },
      reputation: 'strong',
      summary: "Levi's lists the 501 at $98; used ones ask $30-$50 on Poshmark and eBay.",
    };

    async function researchCalls(): Promise<number[]> {
      const rows = await api.db
        .selectFrom('ai_usage_event')
        .select(['web_searches'])
        .where('account_id', '=', tenant.accountId)
        .where('purpose', '=', 'thrift_scan_research')
        .execute();
      return rows.map((row) => row.web_searches);
    }

    it('looks the item up on the web after the read, and makes the call again with it', async () => {
      expect(ANALYSIS_WEB_INFO).toBe(WEB_INFO_LABEL);
      const run = await startRun();
      const item = read();
      web(item, found);
      const scanned = (await scan(run.id, (await scanImage(item)).base64)).body;
      // The read never waits on the web: it rests on the AI estimate.
      expect(scanned.research).toBeUndefined();
      expect(scanned.call.basis).toBe('ai_estimate');
      expect(scanned.identity).toMatchObject({ model: '501', era: 'current' });
      const before = (await researchCalls()).length;

      const researched = await api.call('researchScan', { token, params: { scanId: scanned.id } });
      expect(researched.status).toBe(200);
      const body = researched.body;
      expect(body.research).toEqual({
        status: 'found',
        label: WEB_INFO_LABEL,
        retail: {
          low: usd(9_800),
          high: usd(9_800),
          sources: [{ site: 'levi.com', url: RETAIL.url }],
          models: ['501 Original'],
        },
        resale: {
          low: usd(3_000),
          high: usd(5_000),
          sources: [
            { site: 'poshmark.com', url: RESALE[0]?.url },
            { site: 'ebay.com', url: RESALE[1]?.url },
          ],
        },
        reputation: 'strong',
        summary: found.summary,
        cached: false,
      });
      expect(body.retail).toMatchObject({
        source: 'web',
        low: usd(9_800),
        site: 'levi.com',
        label: 'Retail about $98',
      });
      expect(body.call).toMatchObject({
        basis: 'web_info',
        confidence: 'medium',
        call: 'buy',
        basedOn: `${WEB_INFO_LABEL}: poshmark.com, ebay.com`,
        low: usd(3_000),
        high: usd(5_000),
      });
      expect(body.call.signals.map((signal) => signal.kind)).toEqual(['retail', 'web_resale']);
      expect((await researchCalls()).slice(before)).toEqual([2]);
      // Asked again, the scan answers as it is.
      const again = await api.call('researchScan', { token, params: { scanId: scanned.id } });
      expect(again.body).toEqual(body);
      expect((await researchCalls()).length).toBe(before + 1);
      const row = await api.db
        .selectFrom('item_scan')
        .select(['basis', 'research_ms'])
        .where('id', '=', scanned.id)
        .executeTakeFirstOrThrow();
      expect(row.basis).toBe('web_info');
      expect(row.research_ms).toBeGreaterThanOrEqual(0);
    });

    it('reuses research only for the exact model, never just the brand or the item type', async () => {
      const run = await startRun();
      const first = (await scan(run.id, (await scanImage(read())).base64)).body;
      await api.call('researchScan', { token, params: { scanId: first.id } });
      const calls = (await researchCalls()).length;

      // The same exact model, said in other words: instant, from the cache, no search.
      const same = (await scan(run.id, (await scanImage(read({ item: 'blue 501 jeans' }))).base64))
        .body;
      const cached = (await api.call('researchScan', { token, params: { scanId: same.id } })).body;
      expect(cached.research).toMatchObject({
        status: 'found',
        cached: true,
        reputation: 'strong',
      });
      expect((await researchCalls()).length).toBe(calls);

      // Another model of the same brand and type, or another era, is looked up on its own.
      for (const other of [read({ line: '505' }), read({ era: 'vintage 1990s' })]) {
        web(other, {
          ...found,
          retail: { ...found.retail, lowCents: 6_900, highCents: 6_900, models: ['505'] },
        });
        const scanned = (await scan(run.id, (await scanImage(other)).base64)).body;
        const body = (await api.call('researchScan', { token, params: { scanId: scanned.id } }))
          .body;
        expect(body.research?.cached).toBe(false);
        expect(body.retail?.label).toBe('Retail about $69');
      }
      expect((await researchCalls()).length).toBe(calls + 2);
    });

    it('looks an item of unknown model up afresh every time, its retail a range across the likely models', async () => {
      const run = await startRun();
      const unknown = read({ line: '', era: '', item: 'light wash bootcut jeans' });
      web(unknown, {
        ...found,
        retail: {
          lowCents: 5_950,
          highCents: 9_800,
          sourceUrls: [RETAIL.url],
          models: ['501', '517', '527'],
        },
      });
      const calls = (await researchCalls()).length;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const scanned = (await scan(run.id, (await scanImage(unknown)).base64)).body;
        const body = (await api.call('researchScan', { token, params: { scanId: scanned.id } }))
          .body;
        expect(body.research).toMatchObject({ status: 'found', cached: false });
        expect(body.retail).toMatchObject({
          low: usd(5_950),
          high: usd(9_800),
          models: ['501', '517', '527'],
          label: 'Retail $60-$98 across 3 models',
        });
      }
      expect((await researchCalls()).length).toBe(calls + 2);
    });

    it('keeps no price whose page the search never returned, and looks nothing up without a brand', async () => {
      const run = await startRun();
      const item = read({ line: '569' });
      web(item, {
        ...found,
        retail: { ...found.retail, sourceUrls: ['https://made-up.example/569'] },
      });
      const scanned = (await scan(run.id, (await scanImage(item)).base64)).body;
      const body = (await api.call('researchScan', { token, params: { scanId: scanned.id } })).body;
      expect(body.research?.retail).toBeUndefined();
      expect(body.retail).toBeUndefined();
      expect(body.research?.resale?.sources).toHaveLength(2);

      const unbranded = (await scan(run.id, (await scanImage(read({ brand: '' }))).base64)).body;
      const none = (await api.call('researchScan', { token, params: { scanId: unbranded.id } }))
        .body;
      expect(none.research).toMatchObject({ status: 'no_brand', cached: false });
    });
  });

  it('shows a retail price read off a tag in the shot, ahead of the web', async () => {
    const run = await startRun();
    const tagged = await scanImage(
      answer({
        brand: 'Zzyzx Studio',
        category: 'clothing/dresses/jumpsuits_rompers',
        retailPriceCents: 6_800,
        condition: 'new_with_tags',
        style: 'Y2K',
      }),
    );
    const body = (await scan(run.id, tagged.base64)).body;
    expect(body.retail).toEqual({
      low: usd(6_800),
      high: usd(6_800),
      source: 'tag',
      label: 'Retail $68 on the tag',
    });
    expect(body.identity.style).toBe('Y2K');
    expect(body.call.signals.map((signal) => [signal.kind, signal.label])).toEqual([
      ['retail', 'Retail $68 on the tag'],
      ['style', 'Y2K'],
    ]);
    // The AI estimate ($24-$40) is under the tag's $68, so it stands.
    expect(body.call.high).toEqual(usd(4000));
  });
});
