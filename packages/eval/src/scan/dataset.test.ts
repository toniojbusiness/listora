import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScanDataset, scanImages } from './dataset.ts';
import { item, writeScanDataset } from './test-support.ts';

describe('loadScanDataset', () => {
  it('reads a set and its photos in listing order', async () => {
    const dir = await writeScanDataset();
    const dataset = await loadScanDataset(dir);
    expect(dataset.manifest.items).toHaveLength(8);
    const first = dataset.manifest.items[0];
    if (first === undefined) throw new Error('no item');
    const images = await scanImages(dataset, first, 1);
    expect(images).toEqual([
      {
        mediaType: 'image/jpeg',
        data: new Uint8Array(await readFile(join(dir, 'photos/a1-0.jpg'))),
        width: 1024,
        height: 1024,
      },
    ]);
    expect(await scanImages(dataset, first, 2)).toHaveLength(2);
  });

  it('says where the manifest is missing', async () => {
    await expect(loadScanDataset(join('/nonexistent', 'scan-set'))).rejects.toThrow(
      'manifest.json is missing',
    );
  });

  it('refuses a malformed manifest, duplicate ids, and an unknown category', async () => {
    const dir = await writeScanDataset([item('a1')]);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 2 }));
    await expect(loadScanDataset(dir)).rejects.toThrow('malformed');
    await expect(loadScanDataset(await writeScanDataset([item('a1'), item('a1')]))).rejects.toThrow(
      'two items a1',
    );
    await expect(
      loadScanDataset(await writeScanDataset([item('a1', { category: 'clothing/capes' })])),
    ).rejects.toThrow('not a category path');
  });

  it('refuses a photo outside the set or of an unsupported type', async () => {
    const outside = item('a1', { photos: [{ file: '../secret.jpg', width: 1, height: 1 }] });
    await expect(
      loadScanDataset(await writeScanDataset([item('a2')], { items: [outside] })),
    ).rejects.toThrow('outside the scan backtest set');
    const gif = item('a1', { photos: [{ file: 'photos/a1-0.gif', width: 1, height: 1 }] });
    await expect(
      loadScanDataset(await writeScanDataset([item('a2')], { items: [gif] })),
    ).rejects.toThrow('not a JPEG, PNG, or WebP');
  });
});
