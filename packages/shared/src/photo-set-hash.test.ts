import { describe, expect, it } from 'vitest';

import { isSha256Hex, photoSetHash, sha256Hex } from './photo-set-hash.ts';

describe('photoSetHash', () => {
  const a = sha256Hex('front');
  const b = sha256Hex('tag');

  it('hashes the sorted photo hashes, one per line', () => {
    const [first, second] = [a, b].sort();
    expect(photoSetHash([a, b])).toBe(sha256Hex(`${String(first)}\n${String(second)}\n`));
    expect(isSha256Hex(photoSetHash([a, b]))).toBe(true);
  });

  it('is stable for the same photos', () => {
    expect(photoSetHash([a, b])).toBe(photoSetHash([a, b]));
    expect(photoSetHash([a, b])).toBe(
      '3f07813fff31d67f920a9ae27a98b67b7baa5d897db004b92e3d31a057ee4d2e',
    );
  });

  it('depends on the membership of the photos, not their order', () => {
    expect(photoSetHash([b, a])).toBe(photoSetHash([a, b]));
    expect(photoSetHash([a])).not.toBe(photoSetHash([a, b]));
    expect(photoSetHash([a, a])).not.toBe(photoSetHash([a]));
  });

  it('rejects anything that is not a lowercase sha256', () => {
    expect(() => photoSetHash([a.toUpperCase()])).toThrow(TypeError);
    expect(() => photoSetHash(['abc'])).toThrow(TypeError);
  });
});
