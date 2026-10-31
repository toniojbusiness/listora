import { SCAN_OUTPUT_NAME } from '@listora/analysis';
import { useMarketplaceFeatures } from '@listora/marketplaces';
import { claimsSoldData } from '@listora/pricing';
import { RUN_ESTIMATE_AI_LABEL, RUN_ESTIMATE_LABEL, RUN_PROFIT_LABEL } from '@listora/sourcing';
import { photoSetHash, sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

// Invented sellers, items, and prices; no real shop's data.
const OWNER = 'runs.owner@example.com';
const OTHER = 'runs.other@example.com';
const DAY_MS = 24 * 60 * 60 * 1000;
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

/** The AI's answer for a scan, in the model's flat shape: a brand no own sale matches. */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    brand: 'Invented Outdoors',
    item: 'green fleece jacket',
    line: '',
    styleNumber: '',
    era: '',
    material: 'polyester',
    category: 'clothing/outerwear/jackets',
    department: 'men',
    sizeLabel: 'M',
    condition: 'pre_owned_good',
    identityConfidence: 0.9,
    priceEstimate: { lowCents: 2400, midCents: 3200, highCents: 4000 },
    retailPriceCents: 0,
    style: '',
    searchWords: 'invented outdoors fleece',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
    ...overrides,
  };
}

describe('sourcing runs: checkout and the summary (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;
  let otherToken: string;
  let seed = 0;

  beforeAll(async () => {
    api = await createTestApi('sourcing_runs');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
    otherToken = await api.signIn(OTHER);
  });

  afterEach(() => {
    useMarketplaceFeatures('all');
  });

  afterAll(async () => {
    await api.close();
  });

  /** A small JPEG the fake AI answers `output` for, as base64. */
  async function scanImage(output: unknown): Promise<string> {
    seed += 1;
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: seed % 256, g: 90, b: 7 } },
      })
        .jpeg()
        .toBuffer(),
    );
    api.aiControls.fixtures[photoSetHash([sha256Hex(bytes)])] = {
      outputs: { [SCAN_OUTPUT_NAME]: output },
    };
    return Buffer.from(bytes).toString('base64');
  }

  async function startRun(place?: string, as = token) {
    const response = await api.call('createSourcingRun', {
      token: as,
      body: place === undefined ? {} : { place },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function scan(runId: string, output = answer(), extra: Record<string, unknown> = {}) {
    const response = await api.call('createScan', {
      token,
      body: { runId, images: [{ role: 'item', jpegBase64: await scanImage(output) }], ...extra },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function checkout(runId: string, body: Record<string, unknown>, as = token) {
    return api.call('checkoutSourcingRun', {
      token: as,
      params: { runId },
      body: { total: usd(1000), itemCount: 1, keptScanIds: [], ...body },
    });
  }

  async function haulCount(): Promise<number> {
    const rows = await api.db
      .selectFrom('haul')
      .select('id')
      .where('account_id', '=', tenant.accountId)
      .execute();
    return rows.length;
  }

  it('is hidden from a seller until the thrift scan passes live, and on in Test mode', async () => {
    const run = await startRun();
    useMarketplaceFeatures('verified');
    expect((await checkout(run.id, {})).status).toBe(404);
    expect(
      (await api.call('getSourcingRunSummary', { token, params: { runId: run.id } })).status,
    ).toBe(404);
    await api.db
      .updateTable('account')
      .set({ test_mode: true })
      .where('id', '=', tenant.accountId)
      .execute();
    try {
      const summary = await api.call('getSourcingRunSummary', { token, params: { runId: run.id } });
      expect(summary.status).toBe(200);
    } finally {
      await api.db
        .updateTable('account')
        .set({ test_mode: false })
        .where('id', '=', tenant.accountId)
        .execute();
    }
  });

  it('checks the kept items out into one haul, each costing its share, with the estimated profit', async () => {
    const run = await startRun('Goodwill  Outlet on 5th');
    const sent = await scan(run.id);
    const notSent = await scan(
      run.id,
      answer({ priceEstimate: { lowCents: 1600, midCents: 2000, highCents: 2600 } }),
    );
    const left = await scan(run.id);
    // The app already sent one Keep; the other is still in its upload queue.
    const keptEarlier = await api.call('keepScan', { token, params: { scanId: sent.id } });
    expect(keptEarlier.status).toBe(201);

    // Before checkout: the estimate, no haul, no profit.
    const before = await api.call('getSourcingRunSummary', { token, params: { runId: run.id } });
    expect(before.body.haul).toBeUndefined();
    expect(before.body.profitEstimate).toBeUndefined();
    expect(before.body.estimate?.itemCount).toBe(1);

    const response = await checkout(run.id, {
      total: usd(1001),
      itemCount: 5,
      keptScanIds: [notSent.id, sent.id],
      miles: 12,
      purchaseDate: '2026-10-30',
    });
    expect(response.status).toBe(201);
    const summary = response.body;
    expect(summary.run).toMatchObject({
      id: run.id,
      place: 'Goodwill Outlet on 5th',
      scanCount: 3,
      keptCount: 2,
      miles: 12,
    });
    expect(summary.run.endedAt).toBeDefined();
    expect(summary.run.checkedOutAt).toBeDefined();
    expect(summary.keptItems).toBe(2);
    expect(summary.haul).toMatchObject({
      id: summary.run.haulId,
      total: usd(1001),
      itemCount: 5,
      itemsAdded: 2,
      purchaseDate: '2026-10-30',
      purchaseSource: 'Goodwill Outlet on 5th',
    });

    // Every resale number is the kept scans' calls added up: AI estimates, labeled.
    const calls = [notSent.call, sent.call];
    const sum = (pick: (call: (typeof calls)[number]) => number | undefined) =>
      calls.reduce((total, call) => total + (pick(call) ?? 0), 0);
    expect(summary.estimate).toEqual({
      itemCount: 2,
      resaleLow: usd(sum((call) => call.low?.amountCents)),
      resaleHigh: usd(sum((call) => call.high?.amountCents)),
      payoutLow: usd(sum((call) => call.conservativePayout?.amountCents)),
      payoutHigh: usd(sum((call) => call.optimisticPayout?.amountCents)),
      basedOn: '2 from the AI estimate',
      label: RUN_ESTIMATE_AI_LABEL,
    });
    expect(summary.profitEstimate).toEqual({
      low: usd(sum((call) => call.conservativePayout?.amountCents) - 1001),
      high: usd(sum((call) => call.optimisticPayout?.amountCents) - 1001),
      label: RUN_PROFIT_LABEL,
    });
    expect(claimsSoldData(summary.estimate?.basedOn ?? 'sold')).toBe(false);

    // The items, in the order kept: $10.01 over 5 is 201 cents for the first, 200 for the next.
    const items = await api.db
      .selectFrom('inventory_item')
      .select(['id', 'cost_cents', 'purchase_date', 'purchase_source', 'status'])
      .where('haul_id', '=', summary.run.haulId ?? '')
      .orderBy('haul_joined_at')
      .execute();
    const decisions = await api.db
      .selectFrom('item_scan')
      .select(['id', 'decision', 'item_id'])
      .where('run_id', '=', run.id)
      .execute();
    const itemOf = new Map(decisions.map((row) => [row.id, row.item_id]));
    expect(items.map((item) => item.id)).toEqual([itemOf.get(notSent.id), itemOf.get(sent.id)]);
    expect(items.map((item) => item.cost_cents)).toEqual([201, 200]);
    expect(items.every((item) => item.purchase_source === 'Goodwill Outlet on 5th')).toBe(true);
    expect(items.every((item) => item.status === 'draft')).toBe(true);
    // The scan never kept is skipped, and can no longer be kept.
    expect(decisions.find((row) => row.id === left.id)?.decision).toBe('skipped');
    expect((await api.call('keepScan', { token, params: { scanId: left.id } })).status).toBe(409);

    // The app's Keep that was still queued answers the item checkout made: never a second one.
    const late = await api.call('keepScan', { token, params: { scanId: notSent.id } });
    expect(late.status).toBe(200);
    expect(late.body.id).toBe(itemOf.get(notSent.id));
    expect(late.body.haul?.id).toBe(summary.run.haulId);

    // The summary reads the same afterwards, and follows the haul when its total is fixed.
    const again = await api.call('getSourcingRunSummary', { token, params: { runId: run.id } });
    expect(again.body).toEqual(summary);
    await api.call('replaceHaul', {
      token,
      params: { haulId: summary.run.haulId ?? '' },
      body: { total: usd(2000), itemCount: 5 },
    });
    const fixed = await api.call('getSourcingRunSummary', { token, params: { runId: run.id } });
    expect(fixed.body.profitEstimate?.low.amountCents).toBe(
      sum((call) => call.conservativePayout?.amountCents) - 2000,
    );
  });

  it("grows the haul's count to the kept items, and leaves out an item with nothing to go on", async () => {
    const run = await startRun();
    const priced = await scan(run.id);
    const unpriced = await scan(
      run.id,
      answer({
        brand: '',
        category: '',
        priceEstimate: { lowCents: 0, midCents: 0, highCents: 0 },
      }),
    );
    expect(unpriced.call.basis).toBe('none');
    const response = await checkout(run.id, {
      total: usd(500),
      itemCount: 1,
      keptScanIds: [priced.id, unpriced.id],
    });
    expect(response.status).toBe(201);
    expect(response.body.haul).toMatchObject({ itemCount: 2, itemsAdded: 2 });
    expect(response.body.keptItems).toBe(2);
    expect(response.body.estimate?.itemCount).toBe(1);
    // The run's start date when the app sends none, and no place or miles.
    expect(response.body.haul?.purchaseDate).toBe(run.startedAt.slice(0, 10));
    expect(response.body.haul?.purchaseSource).toBeUndefined();
    expect(response.body.run.miles).toBeUndefined();
  });

  it('has no estimate and no profit when nothing kept had a range, and checks out with nothing kept', async () => {
    const run = await startRun();
    await scan(run.id);
    const response = await checkout(run.id, { total: usd(300), itemCount: 2, keptScanIds: [] });
    expect(response.status).toBe(201);
    expect(response.body.keptItems).toBe(0);
    expect(response.body.estimate).toBeUndefined();
    expect(response.body.profitEstimate).toBeUndefined();
    expect(response.body.haul).toMatchObject({ total: usd(300), itemCount: 2, itemsAdded: 0 });
  });

  it('labels the estimate "Estimated" when every range is the household\'s own sales', async () => {
    for (const cents of [2200, 2600, 3000]) {
      const item = await api.call('createItem', {
        token,
        body: {
          details: {
            title: 'Fleece',
            brand: 'Owned Brand',
            category: 'clothing/outerwear/jackets',
          },
        },
      });
      const sale = await api.db
        .insertInto('sale')
        .values({
          account_id: tenant.accountId,
          marketplace: 'depop',
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
          marketplace: 'depop',
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
    const run = await startRun();
    const scanned = await scan(run.id, answer({ brand: 'Owned Brand' }));
    expect(scanned.call.basis).toBe('own_history');
    const response = await checkout(run.id, { keptScanIds: [scanned.id] });
    expect(response.body.estimate).toMatchObject({
      basedOn: '1 from your own sales',
      label: RUN_ESTIMATE_LABEL,
    });
  });

  it('replays a retried checkout, and refuses a second one or an ended run', async () => {
    const run = await startRun();
    const scanned = await scan(run.id);
    const body = { total: usd(800), itemCount: 1, keptScanIds: [scanned.id] };
    const hauls = await haulCount();
    const first = await api.call('checkoutSourcingRun', {
      token,
      params: { runId: run.id },
      body,
      idempotencyKey: 'checkout-retry-0001',
    });
    const replay = await api.call('checkoutSourcingRun', {
      token,
      params: { runId: run.id },
      body,
      idempotencyKey: 'checkout-retry-0001',
    });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect((await haulCount()) - hauls).toBe(1);
    const second = await checkout(run.id, body);
    expect(second.status).toBe(409);
    expect((await haulCount()) - hauls).toBe(1);

    const ended = await startRun();
    await scan(ended.id);
    await api.call('endSourcingRun', { token, params: { runId: ended.id } });
    expect((await checkout(ended.id, {})).status).toBe(409);
  });

  it("refuses another account's run, a scan of another run or replaced, and a negative total, changing nothing", async () => {
    const run = await startRun();
    const first = await scan(run.id);
    const second = await scan(run.id, answer(), { replacesScanId: first.id });
    const elsewhere = await startRun();
    const foreign = await scan(elsewhere.id);
    const hauls = await haulCount();

    expect((await checkout(run.id, {}, otherToken)).status).toBe(404);
    const wrong = await checkout(run.id, { keptScanIds: [second.id, foreign.id, first.id] });
    expect(wrong.status).toBe(422);
    expect(wrong.error.fieldErrors).toEqual([
      { field: 'keptScanIds[1]', message: 'is not a scan of this run' },
      { field: 'keptScanIds[2]', message: 'was replaced by a later scan of the item' },
    ]);
    const negative = await checkout(run.id, { total: usd(-1), keptScanIds: [second.id] });
    expect(negative.status).toBe(422);
    expect(await haulCount()).toBe(hauls);
    const row = await api.db
      .selectFrom('sourcing_run')
      .select(['ended_at', 'checked_out_at', 'kept_count'])
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ ended_at: null, checked_out_at: null, kept_count: 0 });
    expect(
      (await api.call('getSourcingRunSummary', { token: otherToken, params: { runId: run.id } }))
        .status,
    ).toBe(404);
  });
});
