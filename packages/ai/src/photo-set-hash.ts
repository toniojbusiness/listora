import { photoSetHash, sha256Hex } from '@listora/shared';

/**
 * The photo-set hash (`photoSetHash` in @listora/shared) of uploads given as their bytes, in
 * order. It equals an item's `ai_analysis.photo_set_hash` only when these are the uploaded
 * files themselves (tests, the eval corpus); a request built from derivatives must carry the
 * item's hash (`itemPhotoSet().hash`) instead.
 */
export function photoSetHashOfImages(images: readonly { readonly data: Uint8Array }[]): string {
  return photoSetHash(images.map((image) => sha256Hex(image.data)));
}
