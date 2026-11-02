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
import { researchKeyHash } from './readers.ts';

/**
 * Fixtures for `--provider fake`: each item's scan answer from the set's own labels (its brand
 * and category) with a price guess from its asking price, never its sale price, and its web
 * research (`--research`): web asking prices of one to two times its asking price. Like the tag
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
    const research = fakeResearchAnswer(item);
    fixtures[researchKeyHash(item)] = {
      description: `${item.id}: web asking prices from the set's asking price`,
      outputs: { [SCAN_RESEARCH_OUTPUT_NAME]: research },
      webSources: research.resale.sourceUrls.map((url) => ({ url, title: 'Invented listing' })),
    };
  }
  return inMemoryFixtures(fixtures);
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

/** The web's asking prices as one to two times the item's asking price, on one invented page. */
export function fakeResearchAnswer(item: ScanDatasetItem): ScanResearchAnswer {
  const asking = item.askingPriceCents ?? 0;
  return {
    retail: { lowCents: 0, highCents: 0, sourceUrls: [], models: [] },
    resale:
      asking === 0
        ? { lowCents: 0, highCents: 0, sourceUrls: [] }
        : {
            lowCents: asking,
            highCents: asking * 2,
            sourceUrls: [`https://www.depop.com/products/invented-${item.id}/`],
          },
    reputation: 'unknown',
    summary: '',
  };
}
