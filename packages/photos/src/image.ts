import { sha256Hex } from '@listora/shared';
import sharp, { type SharpOptions } from 'sharp';

import { DERIVATIVE_KINDS, DERIVATIVES, type DerivativeKind } from './derivatives.ts';
import { perceptualHash, PHASH_SAMPLE_SIZE } from './phash.ts';

/** Largest accepted upload: 50 megapixels (clients send at most 2048 px on the long edge). */
export const MAX_INPUT_PIXELS = 50_000_000;

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
 * Throws `UnusableImageError` for files that cannot become a photo.
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
  let format: string | undefined;
  try {
    ({ format } = await sharp(bytes, input).metadata());
  } catch (error) {
    throw unreadable(error);
  }
  if (format !== 'jpeg') {
    throw new UnusableImageError('not_jpeg', 'This file is not a JPEG image. Upload a JPEG photo.');
  }

  try {
    const upright = sharp(bytes, input).autoOrient();
    const derived = await Promise.all(
      DERIVATIVE_KINDS.map(async (kind): Promise<DerivedImage> => {
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
        return {
          kind,
          bytes: output,
          width: info.width,
          height: info.height,
          sha256: sha256Hex(output),
        };
      }),
    );
    const grey = await upright
      .clone()
      .greyscale()
      .resize(PHASH_SAMPLE_SIZE, PHASH_SAMPLE_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer();
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
  } catch (error) {
    throw unreadable(error);
  }
}

function unreadable(error: unknown): UnusableImageError {
  if (error instanceof Error && /pixel limit/i.test(error.message)) {
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
