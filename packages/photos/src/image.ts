import { sha256Hex } from '@listora/shared';
import sharp, { type Sharp, type SharpOptions } from 'sharp';

import { DERIVATIVE_KINDS, DERIVATIVES, type DerivativeKind } from './derivatives.ts';
import { perceptualHash, PHASH_SAMPLE_SIZE } from './phash.ts';

/**
 * Largest accepted upload: 4096 x 4096 pixels, four times what a client sends (at most 2048 px
 * on the long edge). The bound keeps a small, highly compressed file from decoding into
 * hundreds of megabytes in the worker.
 */
export const MAX_INPUT_PIXELS = 4096 * 4096;

/** Every JPEG starts with a start-of-image marker followed by another marker. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

/** Why a file cannot become a photo; `message` is shown to the user. */
export class UnusableImageError extends Error {
  readonly code: 'not_jpeg' | 'unreadable' | 'too_large';

  constructor(code: UnusableImageError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnusableImageError';
    this.code = code;
  }
}

export interface DerivedImage {
  kind: DerivativeKind;
  bytes: Uint8Array;
  width: number;
  height: number;
  sha256: string;
}

export interface ProcessedImage {
  /** Upright pixel size of the full image. */
  width: number;
  height: number;
  phash: string;
  derivatives: Record<DerivativeKind, DerivedImage>;
}

export interface ProcessImageOptions {
  /** Defaults to `MAX_INPUT_PIXELS`. */
  maxInputPixels?: number;
}

/**
 * Verifies that `bytes` is a readable JPEG and derives every image in `DERIVATIVES`. The EXIF
 * orientation is applied to the pixels, and every output is re-encoded without any metadata:
 * no EXIF (so no GPS position, camera serial, or capture time), XMP, IPTC, or ICC profile.
 * Throws `UnusableImageError` for files that cannot become a photo; any other error (out of
 * memory, a bug) is thrown as is, since retrying may succeed.
 */
export async function processImage(
  bytes: Uint8Array,
  options: ProcessImageOptions = {},
): Promise<ProcessedImage> {
  const input: SharpOptions = {
    // Corrupt or truncated pixel data is an unusable upload, not something to guess around.
    failOn: 'error',
    limitInputPixels: options.maxInputPixels ?? MAX_INPUT_PIXELS,
  };
  // Only JPEG ever reaches a decoder: other formats are refused before libvips parses them.
  if (!JPEG_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new UnusableImageError('not_jpeg', 'This file is not a JPEG image. Upload a JPEG photo.');
  }
  let format: string | undefined;
  try {
    ({ format } = await sharp(bytes, input).metadata());
  } catch (error) {
    throw asUnusable(error);
  }
  if (format !== 'jpeg') {
    throw new UnusableImageError('not_jpeg', 'This file is not a JPEG image. Upload a JPEG photo.');
  }

  let derived: DerivedImage[];
  let grey: Buffer;
  try {
    const upright = sharp(bytes, input).autoOrient();
    // One image at a time, so a job holds at most one decoded copy of the photo.
    derived = [];
    for (const kind of DERIVATIVE_KINDS) derived.push(await derive(upright, kind));
    grey = await upright
      .clone()
      .greyscale()
      .resize(PHASH_SAMPLE_SIZE, PHASH_SAMPLE_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch (error) {
    throw asUnusable(error);
  }
  const derivatives = Object.fromEntries(derived.map((image) => [image.kind, image])) as Record<
    DerivativeKind,
    DerivedImage
  >;
  return {
    width: derivatives.original.width,
    height: derivatives.original.height,
    phash: perceptualHash(new Uint8Array(grey)),
    derivatives,
  };
}

/**
 * One derivative made again from a photo's stored `original` (already upright, sRGB, and
 * metadata-free), for a derivative whose size changed after the photo was processed.
 */
export async function deriveFromOriginal(
  original: Uint8Array,
  kind: DerivativeKind,
): Promise<DerivedImage> {
  return derive(sharp(original, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }), kind);
}

/** One derivative of the upright image: resized to its kind's edge, sRGB, no metadata. */
async function derive(upright: Sharp, kind: DerivativeKind): Promise<DerivedImage> {
  const { maxEdge, quality } = DERIVATIVES[kind];
  let pipeline = upright.clone();
  if (maxEdge !== undefined) {
    pipeline = pipeline.resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const { data, info } = await pipeline
    .toColourspace('srgb')
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  const output = new Uint8Array(data);
  return { kind, bytes: output, width: info.width, height: info.height, sha256: sha256Hex(output) };
}

/**
 * How libvips reports a file it cannot decode: the loader's own errors (`VipsJpeg: ...`) and
 * sharp's input checks (`Input buffer has corrupt header`, `Input image exceeds pixel limit`).
 */
const INPUT_ERROR = /^(?:Input (?:buffer|file|image)\b|VipsJpeg:)/;

/**
 * The `UnusableImageError` for an error about the file itself. Any other error (out of memory,
 * a bad option, a bug) is returned unchanged, so the job is retried and the upload kept.
 */
function asUnusable(error: unknown): unknown {
  if (!(error instanceof Error) || !INPUT_ERROR.test(error.message)) return error;
  if (/pixel limit/i.test(error.message)) {
    return new UnusableImageError(
      'too_large',
      'This photo has too many pixels. Upload one of at most 50 megapixels.',
      { cause: error },
    );
  }
  return new UnusableImageError(
    'unreadable',
    'This file could not be read as an image. Take or choose the photo again.',
    { cause: error },
  );
}
