import { createHash } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Lowercase hex SHA-256 of bytes or of a UTF-8 string. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * The key of an analyzed photo set (`ai_analysis.photo_set_hash`): the sha256 of the ordered
 * photo sha256s, each as lowercase hex followed by a newline. Reordering the photos changes it.
 */
export function photoSetHash(photoSha256s: readonly string[]): string {
  for (const hash of photoSha256s) {
    if (!isSha256Hex(hash)) throw new TypeError('photo hashes must be lowercase sha256 hex');
  }
  return sha256Hex(photoSha256s.map((hash) => `${hash}\n`).join(''));
}
