import {
  inMemoryFixtures,
  photoSetHashOfImages,
  type FakeFixture,
  type FixtureSource,
} from '@listora/ai';
import {
  SCAN_OUTPUT_NAME,
  SCAN_RESEARCH_OUTPUT_NAME,
  type ScanAnswer,
  type ScanResearchAnswer,
} from '@listora/analysis';

import { scanImages, type ScanDataset, type ScanDatasetItem } from './dataset.ts';
import { researchKeyHash } from './research.ts';

/**
 * Fixtures for `--provider fake`: each item's scan answer from the set's own labels (its brand
 * and category) with a price guess from its asking price, never its sale price. Like the tag
 * eval's fake, it measures the plumbing (images, schema, metering, scoring), not a model.
 */
export async function fakeScanFixtures(
  dataset: ScanDataset,
  images: number,
): Promise<FixtureSource> {
  const fixtures: Record<string, FakeFixture> = {};
  for (const item of dataset.manifest.items) {
    const hash = photoSetHashOfImages(await scanImages(dataset, item, images));
    fixtures[hash] = {
      description: `${item.id}: the set's labels`,
      outputs: { [SCAN_OUTPUT_NAME]: fakeScanAnswer(item) },
    };
    fixtures[researchKeyHash(item)] = {
      description: `${item.id}: invented web pages from its asking price`,
      outputs: { [SCAN_RESEARCH_OUTPUT_NAME]: fakeResearchAnswer(item) },
      webSources: [{ url: fakeResalePage(item), title: 'invented resale page' }],
      usage: { webSearches: 1 },
    };
  }
  return inMemoryFixtures(fixtures);
}

/** An invented resale marketplace page for an item, which only the fake answer cites. */
function fakeResalePage(item: ScanDatasetItem): string {
  return `https://poshmark.com/listing/invented-${item.id}`;
}

/** The fake web research: what the item asked, as if a resale marketplace's page said so. */
export function fakeResearchAnswer(item: ScanDatasetItem): ScanResearchAnswer {
  const asking = item.askingPriceCents ?? 0;
  return {
    retail: { lowCents: 0, highCents: 0, sourceUrls: [], models: [] },
    resale:
      asking === 0
        ? { lowCents: 0, highCents: 0, sourceUrls: [] }
        : {
            lowCents: Math.round(asking * 0.8),
            highCents: Math.round(asking * 1.2),
            sourceUrls: [fakeResalePage(item)],
          },
    reputation: 'average',
    summary: '',
  };
}

export function fakeScanAnswer(item: ScanDatasetItem): ScanAnswer {
  const asking = item.askingPriceCents ?? 0;
  return {
    brand: item.brand ?? '',
    item: item.title.slice(0, 120) || 'item',
    line: '',
    styleNumber: '',
    era: '',
    material: '',
    category: item.category ?? '',
    department: '',
    sizeLabel: '',
    condition: '',
    identityConfidence: item.brand === null ? 0.5 : 0.9,
    priceEstimate:
      asking === 0
        ? { lowCents: 0, midCents: 0, highCents: 0 }
        : {
            lowCents: Math.max(1, Math.round(asking * 0.6)),
            midCents: Math.max(1, Math.round(asking * 0.8)),
            highCents: asking,
          },
    retailPriceCents: 0,
    style: '',
    searchWords: '',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
  };
}
