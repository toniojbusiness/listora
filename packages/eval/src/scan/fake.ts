import {
  inMemoryFixtures,
  photoSetHashOfImages,
  type FakeFixture,
  type FixtureSource,
} from '@listora/ai';
import { SCAN_OUTPUT_NAME, type ScanAnswer } from '@listora/analysis';

import { scanImages, type ScanDataset, type ScanDatasetItem } from './dataset.ts';

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
  }
  return inMemoryFixtures(fixtures);
}

export function fakeScanAnswer(item: ScanDatasetItem): ScanAnswer {
  const asking = item.askingPriceCents ?? 0;
  return {
    brand: item.brand ?? '',
    item: item.title.slice(0, 120) || 'item',
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
    searchWords: '',
    flags: { visibleDamage: false, lotOrBundle: false, counterfeitProne: false },
  };
}
