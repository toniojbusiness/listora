/**
 * The scan's inline images (docs/features/thrift-scan.md): small JPEGs sent in the request,
 * checked here before they go to the AI. They are never stored; only their hash is kept.
 */
import type { FieldError, ScanCreate } from '@listora/api-contract';
import type { AiImage } from '@listora/ai';
import { sha256Hex } from '@listora/shared';

/** The most bytes one scan image may have once decoded; the app sends about 150 KB. */
export const MAX_SCAN_IMAGE_BYTES = 350_000;
/** The longest side a scan image may have, in pixels; the app sends 1024. */
export const MAX_SCAN_IMAGE_EDGE = 1600;

export interface ScanImageInput {
  readonly role: ScanCreate['images'][number]['role'];
  readonly image: AiImage;
  readonly sha256: string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes and checks the request's images: base64 that is a JPEG of at most
 * `MAX_SCAN_IMAGE_BYTES` and `MAX_SCAN_IMAGE_EDGE` pixels, the item first and at most one tag
 * close-up. Answers the images, or the field errors of every one that fails.
 */
export function decodeScanImages(
  images: ScanCreate['images'],
): { ok: true; images: ScanImageInput[] } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const decoded: ScanImageInput[] = [];
  if (images[0]?.role !== 'item') {
    errors.push({ field: 'images[0].role', message: 'The first image is the item.' });
  }
  if (images.slice(1).some((image) => image.role !== 'tag')) {
    errors.push({ field: 'images', message: 'After the item, only a tag close-up.' });
  }
  for (const [index, image] of images.entries()) {
    const field = `images[${String(index)}].jpegBase64`;
    const bytes = BASE64.test(image.jpegBase64)
      ? new Uint8Array(Buffer.from(image.jpegBase64, 'base64'))
      : undefined;
    if (bytes === undefined || bytes.length === 0) {
      errors.push({ field, message: 'Not base64.' });
      continue;
    }
    if (bytes.length > MAX_SCAN_IMAGE_BYTES) {
      errors.push({ field, message: `Larger than ${String(MAX_SCAN_IMAGE_BYTES)} bytes.` });
      continue;
    }
    const size = jpegSize(bytes);
    if (size === undefined) {
      errors.push({ field, message: 'Not a JPEG.' });
      continue;
    }
    if (Math.max(size.width, size.height) > MAX_SCAN_IMAGE_EDGE) {
      errors.push({ field, message: `Over ${String(MAX_SCAN_IMAGE_EDGE)} pixels on a side.` });
      continue;
    }
    decoded.push({
      role: image.role,
      image: { mediaType: 'image/jpeg', data: bytes, ...size },
      sha256: sha256Hex(bytes),
    });
  }
  return errors.length === 0 ? { ok: true, images: decoded } : { ok: false, errors };
}

/** Start-of-frame markers that carry the image's size (every SOFn but DHT, JPG, and DAC). */
const SIZE_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * The pixel size from a JPEG's frame header, read without decoding the image; undefined when
 * the bytes are not a JPEG with one. (EXIF orientation is not applied: only the long side is
 * checked.)
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2) return undefined;
    if (SIZE_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    // The image data starts without a frame header first: not a JPEG we can size.
    if (marker === 0xda) return undefined;
    offset += 2 + length;
  }
  return undefined;
}
