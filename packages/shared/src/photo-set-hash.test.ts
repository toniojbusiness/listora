import { describe, expect, it } from 'vitest';

import { isSha256Hex, photoSetHash, sha256Hex } from './photo-set-hash.ts';

describe('photoSetHash', () => {
  const a = sha256Hex('front');
  const b = sha256Hex('tag');

  it('hashes the ordered photo hashes, one per line', () => {
    expect(photoSetHash([a, b])).toBe(sha256Hex(`${a}\n${b}\n`));
    expect(isSha256Hex(photoSetHash([a, b]))).toBe(true);
  });

  it('is stable for the same photos in the same order', () => {
    expect(photoSetHash([a, b])).toBe(photoSetHash([a, b]));
    expect(photoSetHash([a, b])).toBe(
      '178f399d862edd4f1e5f89e3d98181219da36212c3322dd000efc57ab37d4b23',
    );
  });

  it('depends on the order and the membership of the photos', () => {
    expect(photoSetHash([a, b])).not.toBe(photoSetHash([b, a]));
    expect(photoSetHash([a])).not.toBe(photoSetHash([a, b]));
  });

  it('rejects anything that is not a lowercase sha256', () => {
    expect(() => photoSetHash([a.toUpperCase()])).toThrow(TypeError);
    expect(() => photoSetHash(['abc'])).toThrow(TypeError);
  });
});
