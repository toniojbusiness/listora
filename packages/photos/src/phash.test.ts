import { describe, expect, it } from 'vitest';

import { hammingDistance, perceptualHash, PHASH_SAMPLE_SIZE } from './phash.ts';

const PIXELS = PHASH_SAMPLE_SIZE * PHASH_SAMPLE_SIZE;

describe('perceptualHash', () => {
  it('sets only the brightness bit for a flat image', () => {
    // Only the DC coefficient is non-zero, so it alone is above the median.
    expect(perceptualHash(new Uint8Array(PIXELS).fill(128))).toBe('8000000000000000');
  });

  it('is unchanged by a uniform brightness shift, which only moves the DC coefficient', () => {
    const gradient = Uint8Array.from({ length: PIXELS }, (_, i) => (i % PHASH_SAMPLE_SIZE) * 4);
    const brighter = gradient.map((value) => value + 50);
    expect(perceptualHash(brighter)).toBe(perceptualHash(gradient));
  });

  it('tells a picture from its mirror image', () => {
    const gradient = Uint8Array.from({ length: PIXELS }, (_, i) => (i % PHASH_SAMPLE_SIZE) * 4);
    const mirrored = Uint8Array.from(
      { length: PIXELS },
      (_, i) => (PHASH_SAMPLE_SIZE - 1 - (i % PHASH_SAMPLE_SIZE)) * 4,
    );
    expect(hammingDistance(perceptualHash(gradient), perceptualHash(mirrored))).toBeGreaterThan(0);
  });

  it('needs exactly 32 x 32 grey pixels', () => {
    expect(() => perceptualHash(new Uint8Array(10))).toThrow(RangeError);
  });
});

describe('hammingDistance', () => {
  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
  });
});
