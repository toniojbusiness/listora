import { sha256Hex } from '@listora/shared';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DERIVATIVE_KINDS } from './derivatives.ts';
import {
  IMAGE_THREADS,
  limitImageThreads,
  MAX_INPUT_PIXELS,
  processImage,
  UnusableImageError,
  type ProcessedImage,
} from './image.ts';
import { hammingDistance, type perceptualHash } from './phash.ts';
import { fixtureJpeg, readMetadata } from './test-support.ts';

const phashFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('./phash.ts', async (importOriginal) => {
  const actual = await importOriginal<{ perceptualHash: typeof perceptualHash }>();
  return {
    ...actual,
    perceptualHash: (grey: Uint8Array) => {
      if (phashFailure.error) throw phashFailure.error;
      return actual.perceptualHash(grey);
    },
  };
});

async function unusable(bytes: Uint8Array, options?: Parameters<typeof processImage>[1]) {
  const error = await processImage(bytes, options).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UnusableImageError);
  return error as UnusableImageError;
}

describe('processImage', () => {
  let landscape: Uint8Array;
  let processed: ProcessedImage;

  beforeAll(async () => {
    landscape = await fixtureJpeg({ width: 3000, height: 2000 });
    processed = await processImage(landscape);
  });

  it('derives each image at its size, keeping the aspect ratio', () => {
    expect(processed.width).toBe(3000);
    expect(processed.height).toBe(2000);
    const sizes = Object.fromEntries(
      DERIVATIVE_KINDS.map((kind) => {
        const { width, height } = processed.derivatives[kind];
        return [kind, [width, height]];
      }),
    );
    expect(sizes).toEqual({
      original: [3000, 2000],
      ai: [1024, 683],
      thumbnail: [640, 427],
      listing: [1600, 1067],
    });
  });

  it('writes JPEGs whose recorded size and sha256 match their bytes', async () => {
    for (const kind of DERIVATIVE_KINDS) {
      const derived = processed.derivatives[kind];
      const metadata = await readMetadata(derived.bytes);
      expect(metadata.format).toBe('jpeg');
      expect([metadata.width, metadata.height]).toEqual([derived.width, derived.height]);
      expect(derived.sha256).toBe(sha256Hex(derived.bytes));
    }
  });

  it('strips GPS, EXIF, XMP, and ICC data and applies the orientation to the pixels', async () => {
    // A portrait photo as phones store it: landscape pixels plus "rotate 90" in EXIF.
    const phonePhoto = await fixtureJpeg({ width: 3000, height: 2000, gps: true, orientation: 6 });
    const source = await readMetadata(phonePhoto);
    expect(source).toMatchObject({ hasExif: true, hasGps: true, hasXmp: true, orientation: 6 });

    const result = await processImage(phonePhoto);
    expect([result.width, result.height]).toEqual([2000, 3000]);
    for (const kind of DERIVATIVE_KINDS) {
      const metadata = await readMetadata(result.derivatives[kind].bytes);
      expect(metadata, kind).toMatchObject({
        hasExif: false,
        hasGps: false,
        hasXmp: false,
        hasIptc: false,
        hasIcc: false,
        orientation: undefined,
      });
      // Upright: portrait in pixels, so viewers that ignore EXIF show it the right way up.
      expect(metadata.height ?? 0, kind).toBeGreaterThan(metadata.width ?? 0);
    }
    expect([result.derivatives.listing.width, result.derivatives.listing.height]).toEqual([
      1067, 1600,
    ]);
  });

  it('never enlarges a small upload', async () => {
    const small = await processImage(await fixtureJpeg({ width: 300, height: 200 }));
    for (const kind of DERIVATIVE_KINDS) {
      expect([small.derivatives[kind].width, small.derivatives[kind].height], kind).toEqual([
        300, 200,
      ]);
    }
  });

  it('gives stable hashes: the same upload always produces the same images and pHash', async () => {
    const again = await processImage(landscape);
    expect(again.phash).toBe(processed.phash);
    for (const kind of DERIVATIVE_KINDS) {
      expect(again.derivatives[kind].sha256, kind).toBe(processed.derivatives[kind].sha256);
    }
    expect(processed.phash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives near pHashes to the same picture re-encoded and far ones to another picture', async () => {
    const recompressed = await processImage(
      await fixtureJpeg({ width: 1500, height: 1000, quality: 60 }),
    );
    const other = await processImage(await fixtureJpeg({ width: 3000, height: 2000, seed: 5 }));
    expect(hammingDistance(processed.phash, recompressed.phash)).toBeLessThanOrEqual(4);
    expect(hammingDistance(processed.phash, other.phash)).toBeGreaterThan(12);
  });

  it('rejects a file that is not a JPEG', async () => {
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const error = await unusable(new Uint8Array(png));
    expect(error.code).toBe('not_jpeg');
    expect(error.message).toBe('This file is not a JPEG image. Upload a JPEG photo.');
  });

  it('rejects bytes that are not an image before decoding them, and a truncated JPEG', async () => {
    expect((await unusable(new TextEncoder().encode('not an image'))).code).toBe('not_jpeg');
    expect((await unusable(new Uint8Array([0xff, 0xd8, 0xff]))).code).toBe('unreadable');
    const truncated = landscape.slice(0, Math.floor(landscape.length / 2));
    expect((await unusable(truncated)).code).toBe('unreadable');
  });

  it('rejects an image with more pixels than allowed', async () => {
    const error = await unusable(landscape, { maxInputPixels: 1_000_000 });
    expect(error.code).toBe('too_large');
  });

  it('refuses by default a small file that would decode to more than 4096 x 4096 pixels', async () => {
    // A flat colour compresses to a few kilobytes at any size: a decompression bomb's shape.
    const bomb = await sharp({
      create: { width: 4097, height: 4096, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000);
    expect((await unusable(new Uint8Array(bomb))).code).toBe('too_large');
    expect(MAX_INPUT_PIXELS).toBe(4096 * 4096);
  });

  describe('an error that is not about the file', () => {
    afterEach(() => {
      phashFailure.error = undefined;
    });

    it('is thrown as is, not reported as an unusable upload', async () => {
      const bug = new RangeError('pHash needs 1024 grey pixels, got 2048');
      phashFailure.error = bug;
      await expect(processImage(landscape)).rejects.toBe(bug);
    });

    it('includes a sharp error that is not a decode error', async () => {
      const error = await processImage(landscape, { maxInputPixels: -1 }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnusableImageError);
      expect((error as Error).message).toMatch(/limitInputPixels/);
    });
  });
});

describe('limitImageThreads', () => {
  it('keeps libvips to one thread, and photos still process', async () => {
    const before = sharp.concurrency();
    try {
      limitImageThreads();
      expect(IMAGE_THREADS).toBe(1);
      expect(sharp.concurrency()).toBe(1);
      const processed = await processImage(await fixtureJpeg({ width: 640, height: 480 }));
      expect(processed.derivatives.original.width).toBe(640);
    } finally {
      sharp.concurrency(before);
    }
  });
});
