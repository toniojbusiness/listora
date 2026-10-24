import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal 8-bit grayscale PNG encoder and decoder for the synthetic corpus. Only what the
 * corpus needs: color type 0, bit depth 8, no interlace, filter type 0 on every row.
 */

/** An 8-bit grayscale image, row-major, one byte per pixel (0 = black, 255 = white). */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export function encodePng(raster: Raster): Buffer {
  assertRaster(raster);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // color type: grayscale
  // Bytes 10-12 stay 0: deflate compression, adaptive filtering, no interlace.
  const scanlines = Buffer.alloc(raster.height * (raster.width + 1));
  for (let y = 0; y < raster.height; y += 1) {
    const row = y * (raster.width + 1);
    scanlines[row] = 0; // filter type None
    scanlines.set(raster.pixels.subarray(y * raster.width, (y + 1) * raster.width), row + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Decodes a PNG written by `encodePng`; rejects anything else instead of guessing. */
export function decodePng(file: Uint8Array): Raster {
  const buffer = Buffer.from(file);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    const crc = buffer.readUInt32BE(offset + 8 + length);
    if (crc !== crc32(buffer.subarray(offset + 4, offset + 8 + length))) {
      throw new Error(`PNG chunk ${type} has a bad CRC`);
    }
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 0 || body[12] !== 0) {
        throw new Error('only 8-bit grayscale non-interlaced PNGs are supported');
      }
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const scanlines = inflateSync(Buffer.concat(data));
  if (scanlines.length !== height * (width + 1)) throw new Error('PNG image data is truncated');
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    if (scanlines[row] !== 0) throw new Error('only PNG filter type 0 is supported');
    pixels.set(scanlines.subarray(row + 1, row + 1 + width), y * width);
  }
  return { width, height, pixels };
}

/**
 * Hash of the decoded image (dimensions plus pixels). It identifies the picture independently
 * of the compressor, so a different zlib build cannot fail the corpus drift check.
 */
export function pixelSha256(raster: Raster): string {
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(raster.width, 0);
  dimensions.writeUInt32BE(raster.height, 4);
  return createHash('sha256').update(dimensions).update(raster.pixels).digest('hex');
}

function assertRaster(raster: Raster): void {
  const { width, height, pixels } = raster;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('raster dimensions must be positive integers');
  }
  if (pixels.length !== width * height) {
    throw new RangeError('raster pixel count does not match its dimensions');
  }
}
