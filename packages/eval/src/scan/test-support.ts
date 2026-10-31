/**
 * Test-only helpers: a small invented scan backtest set written to a scratch directory. Brands,
 * titles, and prices are made up; the photos are a few distinct bytes, which the fake provider
 * never decodes.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScanDatasetItem, ScanDatasetManifest } from './dataset.ts';

export function item(id: string, overrides: Partial<ScanDatasetItem> = {}): ScanDatasetItem {
  return {
    id,
    title: `Invented item ${id}`,
    brand: 'Fernhill',
    category: 'clothing/bottoms/jeans',
    salePriceCents: 1_500,
    askingPriceCents: 2_000,
    feesCents: 150,
    soldAt: '2026-10-01T12:00:00Z',
    photos: [
      { file: `photos/${id}-0.jpg`, width: 1024, height: 1024 },
      { file: `photos/${id}-1.jpg`, width: 1024, height: 1024 },
    ],
    ...overrides,
  };
}

/** Five invented jeans of one brand, two tops of another, and one unbranded item. */
export const INVENTED_ITEMS: readonly ScanDatasetItem[] = [
  item('a1', { salePriceCents: 1_400 }),
  item('a2', { salePriceCents: 1_800 }),
  item('a3', { salePriceCents: 2_200 }),
  item('a4', { salePriceCents: 1_600 }),
  item('a5', { salePriceCents: 2_000 }),
  item('b1', { brand: 'Quillon', category: 'clothing/tops/blouses', salePriceCents: 500 }),
  item('b2', { brand: 'Quillon', category: 'clothing/tops/blouses', salePriceCents: 600 }),
  item('c1', { brand: null, category: null, salePriceCents: 300, askingPriceCents: null }),
];

export async function writeScanDataset(
  items: readonly ScanDatasetItem[] = INVENTED_ITEMS,
  manifest: Partial<ScanDatasetManifest> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'listora-scan-eval-'));
  await mkdir(join(dir, 'photos'));
  for (const entry of items) {
    for (const photo of entry.photos) {
      await writeFile(join(dir, photo.file), `invented photo ${photo.file}`);
    }
  }
  const full: ScanDatasetManifest = {
    version: 1,
    description: 'an invented test set',
    marketplace: 'depop',
    currency: 'USD',
    items: [...items],
    ...manifest,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(full, null, 2));
  return dir;
}
