import sharp from 'sharp';

import { DERIVATIVES } from './derivatives.ts';

/** Long edge of a tag crop: 784 px is 28 x 28 image-token patches (784 tokens). */
export const TAG_CROP_EDGE = 784;
/** The centered square a tag crop covers, as a share of the photo's short edge. */
export const TAG_CROP_SHARE = 2 / 3;
/** A crop is worth sending only when it shows the tag this much sharper than the `ai` image. */
const MIN_SHARPNESS_GAIN = 1.25;

export interface TagCrop {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * A higher-resolution look at a tag photo for the AI call: the centered square (where the user
 * framed the tag) at up to `TAG_CROP_EDGE` px, cut from the photo's metadata-free `original`
 * derivative. Small print such as RN numbers and fiber percentages stays legible where the
 * 1024 px `ai` image of the whole photo would blur it.
 *
 * Undefined when the original is too small for the crop to be sharper than the `ai` image by
 * `MIN_SHARPNESS_GAIN`; the `ai` image already shows everything the photo has.
 */
export async function tagCrop(original: Uint8Array): Promise<TagCrop | undefined> {
  const image = sharp(original, { failOn: 'error' });
  const { width, height } = await image.metadata();
  const side = Math.floor(Math.min(width, height) * TAG_CROP_SHARE);
  const edge = Math.min(TAG_CROP_EDGE, side);
  // Output pixels per original pixel, for the crop and for the whole-photo `ai` image.
  const cropScale = edge / side;
  const aiScale = Math.min(1, DERIVATIVES.ai.maxEdge / Math.max(width, height));
  if (side < 1 || cropScale < aiScale * MIN_SHARPNESS_GAIN) return undefined;

  const { data, info } = await image
    .extract({
      left: Math.floor((width - side) / 2),
      top: Math.floor((height - side) / 2),
      width: side,
      height: side,
    })
    .resize({ width: edge, height: edge })
    .toColourspace('srgb')
    .jpeg({ quality: DERIVATIVES.ai.quality })
    .toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(data), width: info.width, height: info.height };
}
