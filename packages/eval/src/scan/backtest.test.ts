import { createAiClient, FakeAiProvider, InMemoryUsageStore, loadAiConfig } from '@listora/ai';
import { DEFAULT_SCAN_CALL_SETTINGS } from '@listora/sourcing';
import { describe, expect, it } from 'vitest';

import { runScanBacktest } from './backtest.ts';
import { loadScanDataset, type ScanDataset } from './dataset.ts';
import { fakeScanFixtures } from './fake.ts';
import { AiScanReader, type ScanReader } from './readers.ts';
import { formatScanReport } from './report.ts';
import { INVENTED_ITEMS, writeScanDataset } from './test-support.ts';

const settings = { ...DEFAULT_SCAN_CALL_SETTINGS, worthListingCents: 800 };

async function fakeReader(dataset: ScanDataset, images = 1): Promise<ScanReader> {
  const client = createAiClient(loadAiConfig({ AI_PROVIDER: 'fake' }), {
    usageStore: new InMemoryUsageStore(),
    provider: new FakeAiProvider({ fixtures: await fakeScanFixtures(dataset, images) }),
  });
  let clock = 0;
  return new AiScanReader({
    id: 'fake',
    description: 'fake',
    client,
    images,
    now: () => (clock += 100),
  });
}

describe('runScanBacktest', () => {
  it('compares each item with the other sales and calls it from them alone', async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const report = await runScanBacktest(dataset, { settings });

    expect(report.reader).toBeNull();
    expect(report.read).toBeNull();
    expect(report.dataset).toMatchObject({
      items: 8,
      medianSalePriceCents: 1_500,
      medianPayoutCents: 1_350,
      feeCalibration: { sales: 8, actualFeesCents: 1_200 },
    });
    // The five jeans each match the other four; the two blouses only each other.
    expect(report.ownHistory).toEqual([
      {
        identity: 'labels',
        byLevel: { brand_and_category: 5, brand: 0, category: 0 },
        thin: 2,
        none: 1,
        estimate: expect.objectContaining({ priced: 5 }) as unknown,
      },
    ]);
    expect(report.calls).toEqual([
      {
        identity: 'labels',
        worthListingCents: 800,
        counts: { buy: 5, your_call: 3, skip: 0 },
        byConfidence: { high: 0, medium: 5, low: 3 },
        byBasis: { own_history: 5, market_sold: 0, web_info: 0, ai_estimate: 0, none: 3 },
        buyHeld: 5,
        skipHeld: 0,
      },
    ]);
    expect(report.items.find((entry) => entry.id === 'a1')?.calls.labels?.ownHistory).toEqual({
      level: 'brand_and_category',
      saleIds: ['a2', 'a3', 'a4', 'a5'],
      prices: { count: 4, lowCents: 1_750, medianCents: 1_900, highCents: 2_050 },
    });
  });

  it('scores the AI read against the labels and the real sale prices', async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const report = await runScanBacktest(dataset, { reader: await fakeReader(dataset), settings });

    expect(report.read).toMatchObject({
      scanned: 8,
      failed: 0,
      brand: { labeled: 7, named: 7, agreed: 7 },
      category: { labeled: 7, named: 7, agreed: 7, sameTop: 7 },
      // The fake guesses 60% to 100% of the $20 asking price: four of the jeans sold inside it.
      estimate: { priced: 7, saleInRange: 4 },
      latencyP50Ms: 100,
    });
    expect(report.read?.costMicrosPerScan).toBeGreaterThan(0);
    expect(report.calls.map((scores) => scores.identity)).toEqual(['ai', 'labels']);
    // The blouses' own sales are too few, so the AI estimate decides, at low confidence.
    const blouse = report.items.find((entry) => entry.id === 'b1')?.calls.ai?.call;
    expect(blouse).toMatchObject({ basis: 'ai_estimate', confidence: 'low', call: 'your_call' });
  });

  it('sweeps the worth-listing amount over the same reads', async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const report = await runScanBacktest(dataset, { settings, worthSweepCents: [500, 3_000] });
    expect(report.dataset.worthShare).toEqual([
      { worthListingCents: 500, items: 5 },
      { worthListingCents: 3_000, items: 0 },
    ]);
    expect(report.sweep.map((scores) => [scores.worthListingCents, scores.counts])).toEqual([
      [500, { buy: 5, your_call: 3, skip: 0 }],
      [3_000, { buy: 0, your_call: 3, skip: 5 }],
    ]);
    expect(report.sweep[1]?.skipHeld).toBe(5);
  });

  it('counts a failed read and its cost, and still calls the item from its own sales', async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const failing: ScanReader = {
      id: 'failing',
      description: 'always fails',
      read: () => Promise.resolve({ ok: false, message: 'boom', costMicros: 7, latencyMs: 5 }),
    };
    const report = await runScanBacktest(dataset, { reader: failing, settings });
    expect(report.read).toMatchObject({ scanned: 8, failed: 8, costMicrosTotal: 56 });
    expect(report.calls[0]).toMatchObject({ identity: 'ai', counts: { buy: 0, your_call: 8 } });
  });
});

describe('formatScanReport', () => {
  it('prints counts and money but no title or brand', async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const report = await runScanBacktest(dataset, {
      reader: await fakeReader(dataset, 2),
      settings,
    });
    const text = formatScanReport(report, { items: true });
    expect(text).toContain('Scan backtest: 8 sold items (an invented test set)');
    expect(text).toContain('brand: named 7/7 (100%) of labeled, agreed 7/7 (100%)');
    expect(text).toContain('  a1: sold $14.00');
    for (const entry of INVENTED_ITEMS) {
      expect(text).not.toContain(entry.title);
      if (entry.brand !== null) expect(text).not.toContain(entry.brand);
    }
  });
});
