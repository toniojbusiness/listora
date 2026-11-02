import { createAiClient, FakeAiProvider, InMemoryUsageStore, loadAiConfig } from '@listora/ai';
import { DEFAULT_SCAN_CALL_SETTINGS } from '@listora/sourcing';
import { describe, expect, it } from 'vitest';

import { runScanBacktest } from './backtest.ts';
import { loadScanDataset, type ScanDataset } from './dataset.ts';
import { fakeScanFixtures } from './fake.ts';
import { AiScanReader, AiScanResearcher, type ScanReader, type ScanResearcher } from './readers.ts';
import { formatScanReport } from './report.ts';
import { INVENTED_ITEMS, item, writeScanDataset } from './test-support.ts';

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

async function fakeAi(dataset: ScanDataset, images = 1) {
  return createAiClient(loadAiConfig({ AI_PROVIDER: 'fake' }), {
    usageStore: new InMemoryUsageStore(),
    provider: new FakeAiProvider({ fixtures: await fakeScanFixtures(dataset, images) }),
  });
}

async function fakeResearcher(dataset: ScanDataset): Promise<ScanResearcher> {
  return new AiScanResearcher({ id: 'fake', description: 'fake', client: await fakeAi(dataset) });
}

/** Reads Fernhill as "Fernhil" and Quillon as "Quilon": near misses of a brand. */
function misreading(inner: ScanReader): ScanReader {
  const near: Readonly<Record<string, string>> = { Fernhill: 'Fernhil', Quillon: 'Quilon' };
  return {
    id: 'misread',
    description: 'near misses of each brand',
    read: async (set, entry) => {
      const read = await inner.read(set, entry);
      if (!read.ok || read.scan.brand === null) return read;
      return { ...read, scan: { ...read.scan, brand: near[read.scan.brand] ?? read.scan.brand } };
    },
  };
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
        variant: 'labels',
        byLevel: { brand_and_category: 5, brand: 0, category: 0 },
        thin: 2,
        none: 1,
        estimate: expect.objectContaining({ priced: 5 }) as unknown,
      },
    ]);
    expect(report.calls).toEqual([
      {
        variant: 'labels',
        worthListingCents: 800,
        counts: { buy: 5, your_call: 3, skip: 0 },
        byConfidence: { high: 0, medium: 5, low: 3 },
        byBasis: {
          own_history: 5,
          market_sold: 0,
          retail: 0,
          web_info: 0,
          ai_estimate: 0,
          none: 3,
        },
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
    expect(report.calls.map((scores) => scores.variant)).toEqual([
      'ai',
      'calibrated',
      'anchored',
      'anchored_default',
      'labels',
    ]);
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
    expect(report.calls[0]).toMatchObject({ variant: 'ai', counts: { buy: 0, your_call: 8 } });
  });
});

describe('runScanBacktest calibrated', () => {
  it("scales the AI estimate and the web's asks by the other items' sale-to-asking ratio only", async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const report = await runScanBacktest(dataset, {
      reader: await fakeReader(dataset),
      researcher: await fakeResearcher(dataset),
      settings,
    });
    expect(report.researcher).toEqual({ id: 'fake', description: 'fake' });
    const a1 = report.items.find((entry) => entry.id === 'a1');
    // The other six items with an asking price ($20) sold at 70% to 110% of it (held to 100%),
    // so a1 never weighs its own sale.
    expect(a1?.calls.calibrated?.calibration?.sales).toBe(6);
    expect(a1?.calls.ai?.calibration).toBeUndefined();
    expect(a1?.research).toMatchObject({ ok: true });
    const ratio = a1?.calls.calibrated?.calibration?.saleToAsking ?? 0;
    // The fake AI guesses $12-$16-$20 off the $20 ask, for the named brand.
    expect(a1?.calls.calibrated?.call.aiEstimate).toEqual({
      lowCents: Math.round(1_200 * ratio),
      midCents: Math.round(1_600 * ratio),
      highCents: Math.round(2_000 * ratio),
    });
    // The unbranded item has no asking price, no web lookup, and its AI estimate stands.
    const c1 = report.items.find((entry) => entry.id === 'c1');
    expect(c1?.research).toBeUndefined();

    const all = (variant: string) =>
      report.prices.find((scores) => scores.variant === variant && scores.group === 'all');
    // The fake web asks $20-$40 for items that sold for $5-$22: scaled, they come far closer.
    expect(all('ai')?.webAsks.priced).toBe(7);
    expect(all('calibrated')?.webAsks.medianAbsError).toBeLessThan(
      all('ai')?.webAsks.medianAbsError ?? 0,
    );
    expect(report.prices.map((scores) => `${scores.variant} ${scores.group}`)).toEqual([
      'ai all',
      'ai with retail',
      'ai clothing/bottoms',
      'ai clothing/tops',
      'ai unlabeled',
      'calibrated all',
      'calibrated with retail',
      'calibrated clothing/bottoms',
      'calibrated clothing/tops',
      'calibrated unlabeled',
      'anchored all',
      'anchored with retail',
      'anchored clothing/bottoms',
      'anchored clothing/tops',
      'anchored unlabeled',
      'anchored_default all',
      'anchored_default with retail',
      'anchored_default clothing/bottoms',
      'anchored_default clothing/tops',
      'anchored_default unlabeled',
    ]);
    // The fake web finds no retail price: no anchor, and the anchored calls are today's.
    expect(all('anchored')?.retailAnchor.priced).toBe(0);
    expect(report.retailRatios).toEqual([]);
    expect(a1?.calls.anchored?.call).toEqual(a1?.calls.calibrated?.call);
    expect(formatScanReport(report)).toContain('Prices against the sale');
  });

  it("snaps a near miss to a brand of the other items' sales, never to the item's own", async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const misread = misreading(await fakeReader(dataset));
    const report = await runScanBacktest(dataset, { reader: misread, settings });
    const a1 = report.items.find((entry) => entry.id === 'a1');
    expect(a1?.calls.ai?.identity.brand).toBe('Fernhil');
    expect(a1?.calls.calibrated).toMatchObject({
      identity: { brand: 'Fernhill' },
      snappedFrom: 'Fernhil',
      ownHistory: { level: 'brand_and_category' },
    });
    // b1 snaps by b2's sale of Quillon.
    expect(report.items.find((entry) => entry.id === 'b1')?.calls.calibrated).toMatchObject({
      identity: { brand: 'Quillon' },
      snappedFrom: 'Quilon',
    });

    // The one sale of a brand never snaps its own read: nothing else of the brand sold.
    const alone = await loadScanDataset(
      await writeScanDataset([...INVENTED_ITEMS.slice(0, 5), item('q1', { brand: 'Quillon' })]),
    );
    const single = await runScanBacktest(alone, {
      reader: misreading(await fakeReader(alone)),
      settings,
    });
    const q1 = single.items.find((entry) => entry.id === 'q1');
    expect(q1?.calls.calibrated?.identity.brand).toBe('Quilon');
    expect(q1?.calls.calibrated?.snappedFrom).toBeUndefined();
  });
});

/** The fake web's answer with a retail price of `retail` times each item's asking price. */
function retailResearcher(inner: ScanResearcher, retail: number): ScanResearcher {
  return {
    id: 'retail',
    description: 'the fake web with a retail price',
    research: async (entry, scan) => {
      const found = await inner.research(entry, scan);
      if (found?.ok !== true || entry.askingPriceCents === null) return found;
      const price = Math.round(entry.askingPriceCents * retail);
      return {
        ...found,
        research: {
          ...found.research,
          retail: { lowCents: price, highCents: price, sources: [], models: [] },
        },
      };
    },
  };
}

describe('runScanBacktest anchored', () => {
  it("holds a known retail price at the other items' resale-to-retail ratio ahead of the web", async () => {
    const dataset = await loadScanDataset(await writeScanDataset());
    const report = await runScanBacktest(dataset, {
      reader: await fakeReader(dataset),
      // Retail $80 for every item asking $20: the jeans sold at 17.5%-27.5% of it.
      researcher: retailResearcher(await fakeResearcher(dataset), 4),
      settings,
    });
    // b1's own sales are too few, so today the web's asks hold its range; anchored, its retail.
    const b1 = report.items.find((entry) => entry.id === 'b1');
    expect(b1?.calls.calibrated?.call.basis).toBe('web_info');
    expect(b1?.calls.anchored?.call.basis).toBe('retail');
    expect(b1?.calls.anchored_default?.call.basis).toBe('retail');
    // Its ratio rests on the six other items with a retail price, never its own sale.
    expect(b1?.calls.anchored?.resaleRatio?.sales).toBe(6);
    expect(b1?.calls.anchored_default?.resaleRatio).toEqual({ low: 0.2, high: 0.6, sales: 0 });
    // At the default 20%-60% of $80: $16-$48.
    expect(b1?.calls.anchored_default?.call.range).toEqual({ lowCents: 1_600, highCents: 4_800 });
    // The jeans rest on their own sales either way.
    const a1 = report.items.find((entry) => entry.id === 'a1');
    expect(a1?.calls.anchored?.call).toEqual(a1?.calls.calibrated?.call);

    const all = (variant: string) =>
      report.prices.find((scores) => scores.variant === variant && scores.group === 'all');
    expect(all('anchored')?.retailAnchor.priced).toBe(7);
    expect(all('calibrated')?.retailAnchor.priced).toBe(0);
    // Every source on the items with a retail price, the anchor's own.
    const withRetail = report.prices.find(
      (scores) => scores.variant === 'anchored' && scores.group === 'with retail',
    );
    expect(withRetail).toMatchObject({
      items: 7,
      retailAnchor: { priced: 7 },
      webAsks: { priced: 7 },
    });
    expect(report.retailRatios.map((scores) => [scores.group, scores.items])).toEqual([
      ['all', 7],
      ['clothing/bottoms', 5],
      ['clothing/tops', 2],
    ]);
    // The jeans' $14-$22 over $80.
    expect(report.retailRatios[1]).toMatchObject({ low: 0.2, median: 0.225, high: 0.25 });
    const text = formatScanReport(report);
    expect(text).toContain('Resale to retail');
    expect(text).toContain('anchored_default');
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
