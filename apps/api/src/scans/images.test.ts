import { describe, expect, it } from 'vitest';

import { decodeScanImages, jpegSize, MAX_SCAN_IMAGE_BYTES } from './images.ts';

/** A minimal JPEG header: SOI, an APP0 segment, then a baseline frame header of `w` x `h`. */
function header(width: number, height: number, frame = 0xc0): Uint8Array {
  const soi = [0xff, 0xd8];
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  // A fill byte, then the frame header.
  const sof = [0xff, 0xff, frame, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8];
  return new Uint8Array([...soi, ...app0, ...sof, width & 0xff, 0x03]);
}

describe('jpegSize', () => {
  it('reads the size from the frame header, past other segments and fill bytes', () => {
    expect(jpegSize(header(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(jpegSize(header(300, 2000, 0xc2))).toEqual({ width: 300, height: 2000 });
  });

  it('refuses what is not a JPEG with a frame header', () => {
    expect(jpegSize(new TextEncoder().encode('GIF89a....'))).toBeUndefined();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeUndefined();
    expect(jpegSize(header(0, 10))).toBeUndefined();
  });
});

describe('decodeScanImages', () => {
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  it('decodes the item and a tag close-up, with their hashes', () => {
    const decoded = decodeScanImages([
      { role: 'item', jpegBase64: base64(header(1024, 768)) },
      { role: 'tag', jpegBase64: base64(header(784, 784)) },
    ]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.images.map((image) => [image.role, image.image.width])).toEqual([
      ['item', 1024],
      ['tag', 784],
    ]);
    expect(decoded.images[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names every image that is too big, too wide, or out of order', () => {
    const tooBig = new Uint8Array(MAX_SCAN_IMAGE_BYTES + 1);
    tooBig.set(header(100, 100));
    const decoded = decodeScanImages([
      { role: 'tag', jpegBase64: base64(header(2000, 100)) },
      { role: 'tag', jpegBase64: base64(tooBig) },
    ]);
    expect(decoded.ok ? [] : decoded.errors.map((error) => error.field)).toEqual([
      'images[0].role',
      'images[0].jpegBase64',
      'images[1].jpegBase64',
    ]);
  });
});
