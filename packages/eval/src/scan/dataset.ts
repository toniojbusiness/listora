import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, sep } from 'node:path';

import type { AiImage } from '@listora/ai';
import { CATEGORY_TREE } from '@listora/analysis';
import { z } from 'zod';

/**
 * A scan backtest set: sold items with their photos and what they really sold for. Real sets
 * are private (a household's own sales) and live outside the repository; the format is in
 * docs/features/thrift-scan.md ("Backtest").
 */
export const SCAN_DATASET_MANIFEST = 'manifest.json';

const cents = z.int().min(0).max(100_000_000);

const CATEGORY_PATHS: ReadonlySet<string> = new Set(
  Object.entries(CATEGORY_TREE).flatMap(([category, subcategories]) =>
    subcategories.map((subcategory) => `${category}/${subcategory}`),
  ),
);

const photoSchema = z
  .object({
    /** Relative to the set's directory. */
    file: z.string().min(1),
    width: z.int().positive(),
    height: z.int().positive(),
  })
  .strict();

const itemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    /** The brand as the seller labeled it; null when the item has none or it is unknown. */
    brand: z.string().min(1).nullable(),
    /** The canonical category path, for example `clothing/bottoms/jeans`; null when unknown. */
    category: z
      .string()
      .refine((path) => CATEGORY_PATHS.has(path), 'is not a category path of the vocabulary')
      .nullable(),
    /** What the buyer paid for the item, without shipping. */
    salePriceCents: cents.min(1),
    /** The listing's price when it sold; null when unknown. */
    askingPriceCents: cents.nullable(),
    /** The marketplace's actual fees on the item; null when unknown. */
    feesCents: cents.nullable(),
    soldAt: z.iso.datetime({ offset: true }),
    /** In listing order: the first is the item shot, the second a closer look when present. */
    photos: z.array(photoSchema).min(1),
  })
  .strict();

const manifestSchema = z
  .object({
    version: z.literal(1),
    description: z.string(),
    marketplace: z.literal('depop'),
    currency: z.literal('USD'),
    items: z.array(itemSchema).min(1),
  })
  .strict();

export type ScanDatasetManifest = z.infer<typeof manifestSchema>;
export type ScanDatasetItem = z.infer<typeof itemSchema>;

export interface ScanDataset {
  readonly dir: string;
  readonly manifest: ScanDatasetManifest;
}

const MEDIA_TYPES: Readonly<Record<string, AiImage['mediaType']>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Reads and checks a set: the manifest matches the format, ids are unique, and every photo is
 * a supported image inside the set's directory (it is read later, when the item is scanned).
 */
export async function loadScanDataset(dir: string): Promise<ScanDataset> {
  let text: string;
  try {
    text = await readFile(join(dir, SCAN_DATASET_MANIFEST), 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      throw new Error(`no scan backtest set at ${dir}: ${SCAN_DATASET_MANIFEST} is missing`, {
        cause: error,
      });
    }
    throw error;
  }
  const parsed = manifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`the scan backtest set at ${dir} is malformed: ${parsed.error.message}`);
  }
  const ids = new Set<string>();
  for (const item of parsed.data.items) {
    if (ids.has(item.id)) throw new Error(`the scan backtest set has two items ${item.id}`);
    ids.add(item.id);
    for (const photo of item.photos) {
      photoPath(dir, photo.file);
      mediaType(photo.file);
    }
  }
  return { dir, manifest: parsed.data };
}

/** The item's first `count` photos as AI images. */
export async function scanImages(
  dataset: ScanDataset,
  item: ScanDatasetItem,
  count: number,
): Promise<AiImage[]> {
  return Promise.all(
    item.photos.slice(0, count).map(async (photo) => ({
      mediaType: mediaType(photo.file),
      data: new Uint8Array(await readFile(photoPath(dataset.dir, photo.file))),
      width: photo.width,
      height: photo.height,
    })),
  );
}

function photoPath(dir: string, file: string): string {
  const relative = normalize(file);
  if (isAbsolute(relative) || relative === '..' || relative.startsWith(`..${sep}`)) {
    throw new Error(`photo ${file} is outside the scan backtest set`);
  }
  return join(dir, relative);
}

function mediaType(file: string): AiImage['mediaType'] {
  const type = MEDIA_TYPES[extname(file).toLowerCase()];
  if (type === undefined) throw new Error(`photo ${file} is not a JPEG, PNG, or WebP image`);
  return type;
}
