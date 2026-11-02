import { jsonb, type Marketplace } from '@listora/db';
import {
  BRAND_PULSE_OUTPUT_NAME,
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
import { sql } from 'kysely';
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
    api = await createTestApi('scans', { marketComparisons: false });
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

  /** The scan once its prices are in: the research (and any comparison) came back, or its wait ended. */
  async function priced(scanId: string) {
    const response = await api.call('researchScan', { token, params: { scanId } });
    expect(response.status).toBe(200);
    expect(response.body.pricing?.status).toBe('ready');
    return response.body;
  }

  async function scan(runId: string, base64: string, extra: Record<string, unknown> = {}) {
    return api.call('createScan', {
      token,
      body: { runId, images: [{ role: 'item', jpegBase64: base64 }], ...extra },
    });
  }

  /**
   * A sold item of the owner: a one-item sale on `marketplace`, three days back, sold from a
   * listing asking `asking.listingCents` or, without a listing, at the item's `asking.listCents`.
   */
  async function sell(
    marketplace: Marketplace,
    details: Record<string, unknown>,
    cents: number,
    asking: { listingCents?: number; listCents?: number } = {},
  ) {
    const item = await api.call('createItem', { token, body: { details } });
    const listing =
      asking.listingCents === undefined
        ? undefined
        : await api.db
            .insertInto('marketplace_listing')
            .values({
              account_id: tenant.accountId,
              item_id: item.body.id,
              marketplace,
              price_cents: asking.listingCents,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
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
        ...(listing === undefined ? {} : { listing_id: listing.id }),
      })
      .execute();
    await api.db
      .updateTable('inventory_item')
      .set({
        status: 'sold',
        ...(asking.listCents === undefined ? {} : { list_price_cents: asking.listCents }),
      })
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
    // Each went for 80% of what it asked: two from their listing's price, one from the item's.
    await sell('depop', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 2200, {
      listingCents: 2750,
    });
    await sell('depop', { title: 'Align', brand: 'LULULEMON', category: LEGGINGS }, 2800, {
      listingCents: 3500,
      listCents: 9999,
    });
    await sell('mercari', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 3000, {
      listCents: 3750,
    });
    // eBay's own sales show but never feed the call, nor the calibration.
    await sell('ebay', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 9000, {
      listingCents: 9000,
    });
    await sell('ebay', { title: 'Align', brand: 'Lululemon', category: LEGGINGS }, 9900, {
      listingCents: 9900,
    });
    const run = await startRun();
    const image = await scanImage(answer());
    const response = await scan(run.id, image.base64, {
      note: 'size six, no flaws',
      tagText: ['lululemon', '6'],
    });
    expect(response.status).toBe(201);
    const identity = {
      item: 'black high-rise leggings',
      brand: 'Lululemon',
      model: 'Align',
      material: 'nylon',
      category: LEGGINGS,
      department: 'women',
      sizeLabel: '6',
      condition: 'pre_owned_good',
      confidence: 0.9,
    };
    // The read answers at once with what the item is, and holds every price and the call until
    // the web research is in.
    const held = response.body;
    expect(held.identity).toEqual(identity);
    expect(held.aiEstimate).toBeUndefined();
    expect(held.ownSales).toEqual([]);
    expect(held.realityCheck).toBeUndefined();
    expect(held.call).toEqual({
      call: 'checking',
      label: 'Checking prices',
      confidence: 'high',
      basis: 'none',
      basedOn: 'Checking prices: the web',
      worthListing: usd(800),
      signals: [],
    });
    expect(held.pricing).toMatchObject({
      status: 'checking',
      label: 'Checking prices: the web',
      waitingOn: ['web'],
    });

    // No web fixture: the lookup fails, and the prices show from the rest, naming the web.
    const body = await priced(held.id);
    expect(body.identity).toEqual(identity);
    expect(body.pricing).toMatchObject({
      status: 'ready',
      label: "Checked your sales. Couldn't check the web.",
      missing: [{ source: 'web', label: "Couldn't check the web" }],
    });
    expect(body.call.signals).toContainEqual({
      kind: 'missing',
      label: "Couldn't check the web",
      basedOn: 'The prices rest on what did come back, never on this',
    });
    // The AI's $24-$32-$40 for a named brand, scaled by the household's 80% drawn toward the
    // default 75% as if it were 5 more sales: (3 * 0.8 + 5 * 0.75) / 8 = 0.76875.
    expect(body.aiEstimate).toEqual({
      label: AI_ESTIMATE_LABEL,
      low: usd(1845),
      mid: usd(2460),
      high: usd(3075),
    });
    expect(body.call.signals).toContainEqual({
      kind: 'calibrated',
      label: 'Scaled to your sales',
      basedOn:
        'Your items went for 77% of what they asked (3 sales); the AI estimate is scaled to it',
    });
    // Three sales on Depop and Mercari; the Depop fee table's payout of the low quartile.
    expect(body.call).toMatchObject({
      call: 'buy',
      label: 'Grab',
      confidence: 'medium',
      basis: 'own_history',
      basedOn: 'Your 3 sales like it',
      why: 'Even its low end pays out $24 after fees, over your $8',
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
    // The reality check: the household's own sales, eBay's shown but not priced from, and the
    // web that could not be checked.
    expect(body.realityCheck).toEqual([
      {
        kind: 'own_sales',
        text: 'You sold 2 like it on eBay: $92-$97, most around $95 (shown, not used for the price)',
      },
      { kind: 'own_sales', text: 'You sold 2 like it on Depop: $24-$27, most around $25' },
      { kind: 'missing', text: "Couldn't check the web" },
    ]);
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

  it("snaps a near miss of a brand to the household's own, and leaves another brand alone", async () => {
    await sell(
      'depop',
      { title: 'Baggy', brand: 'Wrenfield', category: 'clothing/bottoms/jeans' },
      1000,
    );
    const run = await startRun();
    const near = await scan(
      run.id,
      (await scanImage(answer({ brand: 'Wrenfeld', category: 'clothing/bottoms/jeans' }))).base64,
    );
    expect(near.status).toBe(201);
    expect(near.body.identity.brand).toBe('Wrenfield');
    // One sale of the brand is too few for the card's own-sales line.
    expect(near.body.ownSales).toEqual([]);
    const row = await api.db
      .selectFrom('item_scan')
      .select('read')
      .where('id', '=', near.body.id)
      .executeTakeFirstOrThrow();
    expect((row.read as { brand: string }).brand).toBe('Wrenfield');
    // "Wrenford" is three letters from it: another brand, kept as read.
    const far = await scan(
      run.id,
      (await scanImage(answer({ brand: 'Wrenford', category: 'clothing/bottoms/jeans' }))).base64,
    );
    expect(far.body.identity.brand).toBe('Wrenford');
  });

  it("warns of the household's unsold items like it, without moving the call", async () => {
    const run = await startRun();
    const image = await scanImage(answer());
    const before = { body: await priced((await scan(run.id, image.base64)).body.id) };
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

    const scanned = await scan(run.id, (await scanImage(answer())).base64);
    expect(scanned.status).toBe(201);
    const again = { body: await priced(scanned.body.id) };
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
    const ai = await priced((await scan(run.id, unknown.base64)).body.id);
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
    // A read with no brand has nothing to look up: priced at once, from the AI estimate.
    const leave = (await scan(run.id, cheap.base64)).body;
    expect(leave.pricing).toMatchObject({ status: 'ready', label: 'Checked your sales.' });
    expect(leave.call).toMatchObject({
      call: 'skip',
      label: 'Leave',
      confidence: 'low',
      why: 'Pays out $5 at most after fees, under your $8',
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
      const before = (await researchCalls()).length;
      const scanned = (await scan(run.id, (await scanImage(item)).base64)).body;
      // The read never waits on the web, but its prices do: the lookup starts with the read.
      expect(scanned.research).toBeUndefined();
      expect(scanned.call.call).toBe('checking');
      expect(scanned.pricing?.waitingOn).toEqual(['web']);
      expect(scanned.identity).toMatchObject({ model: '501', era: 'current' });

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
        // The web's $30-$50 asks, scaled twice by the 0.76875 of the household's three Depop and
        // Mercari sales so far (above), and said to be asks.
        basedOn: `${WEB_INFO_LABEL}: asks on poshmark.com, ebay.com, scaled to your sales`,
        low: usd(1_773),
        high: usd(2_955),
      });
      // The three prices from that range: the middle ($23.64) a $25 realistic sale, the low
      // end ($17.73) a $17 fast sale, and the list price $25 over 0.76875 ($30.75), raised to $35.
      expect(body.call.prices).toEqual({
        listAt: usd(3_500),
        realisticSale: usd(2_500),
        fastSale: usd(1_700),
        basedOn:
          "Likely sale is the middle of the web's asks, scaled to your sales, fast sale its low end; list at leaves room for offers (your items went for 77% of what they asked)",
      });
      expect(body.call.label).toBe('Grab');
      expect(body.call.why).toBe('Even its low end pays out $17 after fees, over your $8');
      expect(body.pricing).toMatchObject({
        status: 'ready',
        label: 'Checked your sales and the web.',
      });
      expect(body.pricing?.missing).toBeUndefined();
      // What the prices rest on, plainly: the web's asks said to be asks, and the retail price.
      expect(body.realityCheck).toEqual([
        { kind: 'web', text: 'Listings on the web ask $30-$50 (poshmark.com, ebay.com)' },
        { kind: 'retail', text: 'Retail about $98 (levi.com)' },
      ]);
      // They lead the signals too, for an app built before them.
      expect(body.call.signals.map((signal) => signal.kind)).toEqual([
        'prices',
        'retail',
        'web_resale',
        'calibrated',
      ]);
      expect(body.call.signals[0]?.label).toBe('List at $35 · Likely sale $25 · Fast sale $17');
      expect(body.call.signals.at(-1)?.basedOn).toBe(
        "Your items went for 77% of what they asked (3 sales); the AI estimate and the web's asking prices are scaled to it",
      );
      // The research's own range is shown as it came: what the web's listings ask.
      expect(body.research?.resale).toMatchObject({ low: usd(3_000), high: usd(5_000) });
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

    describe('the brand pulse', () => {
      const PULSE_PAGES = [
        { url: 'https://www.fashion-weekly.example/denim-revival/', title: 'The denim revival' },
        { url: 'https://www.reddit.com/r/thriftstorehauls/comments/xyz/levis/', title: 'Finds' },
      ];
      const inDemand = {
        verdict: 'in_demand',
        reason: 'Denim coverage has vintage straight jeans trending again.',
        premium: 'Vintage 90s pieces',
        sourceUrls: PULSE_PAGES.map((page) => page.url),
      };

      /** The fake web's pulse for a brand, keyed as the research keys it; absent, it fails. */
      function pulse(brand: string, answer: Record<string, unknown> | undefined) {
        const hash = sha256Hex(`brand_pulse|${brandKey(brand) ?? ''}`);
        if (answer === undefined) {
          Reflect.deleteProperty(api.aiControls.fixtures, hash);
          return;
        }
        api.aiControls.fixtures[hash] = {
          outputs: { [BRAND_PULSE_OUTPUT_NAME]: answer },
          webSources: PULSE_PAGES,
          usage: { webSearches: 1 },
        };
      }

      async function pulseCalls(): Promise<{ outcome: string; web_searches: number }[]> {
        return api.db
          .selectFrom('ai_usage_event')
          .select(['outcome', 'web_searches'])
          .where('account_id', '=', tenant.accountId)
          .where('purpose', '=', 'thrift_scan_brand_pulse')
          .orderBy('created_at')
          .execute();
      }

      async function forgetBrand(brand: string) {
        await api.db
          .deleteFrom('scan_research')
          .where('account_id', '=', tenant.accountId)
          .where('kind', '=', 'brand_pulse')
          .where('key', '=', brandKey(brand) ?? '')
          .execute();
      }

      async function researched(item: Record<string, unknown>) {
        const run = await startRun();
        const scanned = (await scan(run.id, (await scanImage(item)).base64)).body;
        const response = await api.call('researchScan', { token, params: { scanId: scanned.id } });
        expect(response.status).toBe(200);
        return response.body;
      }

      it('asks the wider web of the brand beside the item, shows it under its own label, and never moves the call', async () => {
        await forgetBrand("Levi's");
        const item = read({ line: '501', era: 'vintage 1990s' });
        web(item, found);
        pulse("Levi's", inDemand);
        const before = (await pulseCalls()).length;
        const body = await researched(item);
        // The call is the web info's, as it would be without the pulse.
        expect(body.call).toMatchObject({ basis: 'web_info', call: 'buy', confidence: 'medium' });
        expect(body.call.signals.map((signal) => signal.kind)).toEqual(
          expect.arrayContaining(['retail', 'web_resale', 'brand_pulse']),
        );
        expect(body.call.signals.find((signal) => signal.kind === 'brand_pulse')).toEqual({
          kind: 'brand_pulse',
          label: 'Brand pulse: in demand',
          basedOn:
            `${WEB_INFO_LABEL}: Denim coverage has vintage straight jeans trending again. ` +
            'Asks more: Vintage 90s pieces. (fashion-weekly.example, reddit.com)',
        });
        expect((await pulseCalls()).slice(before)).toEqual([
          { outcome: 'succeeded', web_searches: 1 },
        ]);
        const stored = await api.db
          .selectFrom('item_scan')
          .select('research')
          .where('id', '=', body.id)
          .executeTakeFirstOrThrow();
        expect(stored.research).toMatchObject({
          research: { brandPulse: { verdict: 'in_demand', premium: 'Vintage 90s pieces' } },
        });
      });

      it('is kept a week by the brand alone, so another item of the brand costs no search', async () => {
        await forgetBrand("Levi's");
        pulse("Levi's", inDemand);
        const first = read({ line: '550', era: '' });
        web(first, found);
        await researched(first);
        const calls = (await pulseCalls()).length;

        // Another model, and the same model again from the item cache: the pulse is kept.
        const other = read({ line: '517', era: '', category: JEANS });
        web(other, found);
        for (const again of [other, read({ line: '550', era: '', item: 'blue 550 jeans' })]) {
          const body = await researched(again);
          expect(body.call.signals.map((signal) => signal.label)).toContain(
            'Brand pulse: in demand',
          );
        }
        expect((await pulseCalls()).length).toBe(calls);

        // A week on, the brand is asked again.
        await sql`update scan_research set created_at = now() - interval '8 days'
          where account_id = ${tenant.accountId} and kind = 'brand_pulse'`.execute(api.db);
        await researched(read({ line: '550', era: '', item: 'black 550 jeans' }));
        expect((await pulseCalls()).length).toBe(calls + 1);
      });

      it('shows nothing when the pages say too little, and keeps that a week too', async () => {
        await forgetBrand("Levi's");
        pulse("Levi's", { ...inDemand, verdict: 'unknown', reason: '', premium: '' });
        const item = read({ line: '569', era: '' });
        web(item, found);
        const before = (await pulseCalls()).length;
        const body = await researched(item);
        expect(body.call.signals.map((signal) => signal.kind)).not.toContain('brand_pulse');
        await researched(read({ line: '569', era: '', item: 'grey 569 jeans' }));
        expect((await pulseCalls()).length).toBe(before + 1);
      });

      it('failing never fails the research, and is asked again on the next scan', async () => {
        await forgetBrand("Levi's");
        pulse("Levi's", undefined);
        const item = read({ line: '511', era: '' });
        web(item, found);
        const before = (await pulseCalls()).length;
        const body = await researched(item);
        expect(body.research?.status).toBe('found');
        expect(body.call.basis).toBe('web_info');
        expect(body.call.signals.map((signal) => signal.kind)).not.toContain('brand_pulse');

        pulse("Levi's", inDemand);
        // The item's facts come from the cache; the brand is asked again.
        const again = await researched(read({ line: '511', era: '', item: 'blue 511 jeans' }));
        expect(again.research?.cached).toBe(true);
        expect(again.call.signals.map((signal) => signal.label)).toContain(
          'Brand pulse: in demand',
        );
        expect((await pulseCalls()).slice(before).map((call) => call.outcome)).toEqual([
          'failed',
          'succeeded',
        ]);
      });
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

      // Without a brand nothing is looked up, and the prices never wait for the web.
      const calls = (await researchCalls()).length;
      const unbranded = (await scan(run.id, (await scanImage(read({ brand: '' }))).base64)).body;
      expect(unbranded.pricing?.status).toBe('ready');
      const none = (await api.call('researchScan', { token, params: { scanId: unbranded.id } }))
        .body;
      expect(none.research).toBeUndefined();
      expect(none.pricing?.missing).toBeUndefined();
      expect((await researchCalls()).length).toBe(calls);
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
    const body = await priced((await scan(run.id, tagged.base64)).body.id);
    expect(body.retail).toEqual({
      low: usd(6_800),
      high: usd(6_800),
      source: 'tag',
      label: 'Retail $68 on the tag',
    });
    expect(body.identity.style).toBe('Y2K');
    expect(body.call.signals.map((signal) => [signal.kind, signal.label])).toEqual([
      ['prices', 'List at $35 · Likely sale $25 · Fast sale $18'],
      ['retail', 'Retail $68 on the tag'],
      ['style', 'Y2K'],
      ['calibrated', 'Scaled to your sales'],
      // No web fixture for it: the lookup failed, and the card says so.
      ['missing', "Couldn't check the web"],
    ]);
    expect(body.realityCheck).toEqual([
      { kind: 'retail', text: 'Retail $68 on the tag' },
      { kind: 'missing', text: "Couldn't check the web" },
    ]);
    // The AI estimate ($24-$40, scaled by the household's 0.76875 to $18-$31) is under the
    // tag's $68, so it stands.
    expect(body.call.high).toEqual(usd(3075));
  });
});
