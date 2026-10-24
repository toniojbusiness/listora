import { createHash } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The key of an analyzed photo set (`ai_analysis.photo_set_hash`): the sha256 of the ordered
 * photo sha256s, each as lowercase hex followed by a newline. Reordering the photos changes it.
 */
export function photoSetHash(photoSha256s: readonly string[]): string {
  for (const hash of photoSha256s) {
    if (!SHA256_HEX.test(hash)) throw new TypeError('photo hashes must be lowercase sha256 hex');
  }
  return sha256Hex(photoSha256s.map((hash) => `${hash}\n`).join(''));
}

/** The photo-set hash of the images in a request. */
export function photoSetHashOfImages(images: readonly { readonly data: Uint8Array }[]): string {
  return photoSetHash(images.map((image) => sha256Hex(image.data)));
}
