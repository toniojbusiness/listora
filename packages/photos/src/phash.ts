/**
 * Perceptual hash (DCT pHash, 64 bits): visually similar images get hashes a small Hamming
 * distance apart, unlike sha256, which changes with any byte. Used to spot the same photo
 * uploaded twice and, later, to match imported listings to items.
 *
 * The image is reduced to 32 x 32 grey pixels, transformed with a 2-D DCT, and each of the 64
 * lowest-frequency coefficients becomes one bit: set when it is above their median (the method
 * of pHash.org and Python's `imagehash.phash`).
 */

export const PHASH_SAMPLE_SIZE = 32;
const LOW_FREQUENCIES = 8;

/** cos((2x + 1) u pi / 2N) for every frequency u and sample x. */
const COSINES: readonly Float64Array[] = Array.from({ length: LOW_FREQUENCIES }, (_, u) =>
  Float64Array.from({ length: PHASH_SAMPLE_SIZE }, (_, x) =>
    Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SAMPLE_SIZE)),
  ),
);

/**
 * The 16-hex-digit pHash of 32 x 32 grey pixels (one byte each, row by row), as `photo.phash`
 * stores it.
 */
export function perceptualHash(grey: Uint8Array): string {
  const n = PHASH_SAMPLE_SIZE;
  if (grey.length !== n * n) {
    throw new RangeError(`pHash needs ${String(n * n)} grey pixels, got ${String(grey.length)}`);
  }
  // Rows first: rowDct[y][u] = sum over x of pixel(x, y) * cos(u, x).
  const rowDct = Array.from({ length: n }, (_, y) =>
    COSINES.map((cosines) => {
      let sum = 0;
      for (let x = 0; x < n; x += 1) sum += (grey[y * n + x] ?? 0) * (cosines[x] ?? 0);
      return sum;
    }),
  );
  // Then columns, for the 8 x 8 lowest frequencies only.
  const coefficients: number[] = [];
  for (let v = 0; v < LOW_FREQUENCIES; v += 1) {
    const cosines = COSINES[v] ?? new Float64Array(n);
    for (let u = 0; u < LOW_FREQUENCIES; u += 1) {
      let sum = 0;
      for (let y = 0; y < n; y += 1) sum += (rowDct[y]?.[u] ?? 0) * (cosines[y] ?? 0);
      coefficients.push(sum);
    }
  }
  const sorted = [...coefficients].sort((a, b) => a - b);
  const median = ((sorted[31] ?? 0) + (sorted[32] ?? 0)) / 2;
  // Coefficients that are zero in exact arithmetic come out as rounding noise (about 1e-13);
  // without a tolerance that noise, not the picture, would decide their bits.
  const tolerance = 1e-9 * (Math.abs(coefficients[0] ?? 0) + 1);
  let bits = 0n;
  for (const coefficient of coefficients) {
    bits = (bits << 1n) | (coefficient > median + tolerance ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

/** The number of differing bits between two pHashes (0 = same picture, 64 = opposite). */
export function hammingDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}
