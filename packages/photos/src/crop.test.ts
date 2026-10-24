import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { TAG_CROP_EDGE, tagCrop } from './crop.ts';
import { readMetadata } from './test-support.ts';

/** A photo whose center square is white and everything else black, to see what a crop kept. */
async function centerMarked(width: number, height: number): Promise<Uint8Array> {
  const side = Math.floor(Math.min(width, height) / 3);
  const marker = await sharp({
    create: { width: side, height: side, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#000000' } })
      .composite([{ input: marker, gravity: 'centre' }])
      .jpeg({ quality: 95 })
      .toBuffer(),
  );
}

describe('tagCrop', () => {
  it('cuts the centered square of a full-size photo at the crop edge, as a plain JPEG', async () => {
    const crop = await tagCrop(await centerMarked(2048, 1536));
    expect(crop).toMatchObject({ width: TAG_CROP_EDGE, height: TAG_CROP_EDGE });
    const metadata = await readMetadata(crop?.bytes ?? new Uint8Array());
    expect(metadata).toMatchObject({ format: 'jpeg', hasExif: false, hasIcc: false });
    // The center of the crop is the center of the photo; its corners are outside the marker.
    const { data, info } = await sharp(crop?.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? -1;
    expect(pixel(392, 392)).toBeGreaterThan(200);
    expect(pixel(5, 5)).toBeLessThan(50);
  });

  it('keeps the crop at its own size when the square is smaller than the crop edge', async () => {
    const crop = await tagCrop(await centerMarked(1100, 1800));
    // Two thirds of 1100 px at full resolution: 1.76 times as sharp as the 1024 px ai image.
    expect(crop).toMatchObject({ width: 733, height: 733 });
  });

  it('gives no crop when the photo is too small for it to be sharper than the ai image', async () => {
    expect(await tagCrop(await centerMarked(1024, 768))).toBeUndefined();
    expect(await tagCrop(await centerMarked(640, 480))).toBeUndefined();
  });
});
