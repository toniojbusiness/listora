import { describe, expect, it } from 'vitest';

import { crc32, decodePng, encodePng, pixelSha256 } from './png.ts';

const raster = { width: 3, height: 2, pixels: Uint8Array.from([0, 128, 255, 10, 20, 30]) };

describe('PNG codec', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips an 8-bit grayscale image', () => {
    const file = encodePng(raster);
    expect(file.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(decodePng(file)).toEqual(raster);
  });

  it('hashes pixels and dimensions, not the compressed bytes', () => {
    const transposed = { width: 2, height: 3, pixels: raster.pixels };
    expect(pixelSha256(raster)).toMatch(/^[0-9a-f]{64}$/);
    expect(pixelSha256(raster)).not.toBe(pixelSha256(transposed));
  });

  it('rejects corrupt and unsupported files', () => {
    const file = encodePng(raster);
    const corrupted = Buffer.from(file);
    corrupted[40] = (corrupted[40] ?? 0) ^ 0xff;
    expect(() => decodePng(corrupted)).toThrow(/bad CRC/);
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/not a PNG/);
  });

  it('refuses rasters whose pixel count does not match their size', () => {
    expect(() => encodePng({ width: 2, height: 2, pixels: new Uint8Array(3) })).toThrow(RangeError);
    expect(() => encodePng({ width: 0, height: 2, pixels: new Uint8Array(0) })).toThrow(RangeError);
  });
});
