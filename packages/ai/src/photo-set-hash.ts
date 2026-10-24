import { photoSetHash, sha256Hex } from '@listora/shared';

/** The photo-set hash (`photoSetHash` in @listora/shared) of the images in a request. */
export function photoSetHashOfImages(images: readonly { readonly data: Uint8Array }[]): string {
  return photoSetHash(images.map((image) => sha256Hex(image.data)));
}
