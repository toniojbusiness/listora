import { describe, expect, it } from 'vitest';

import { photoSetHash, photoSetHashOfImages, sha256Hex } from './photo-set-hash.ts';
import { image } from './test-support.ts';

describe('photoSetHash', () => {
  const a = sha256Hex('front');
  const b = sha256Hex('tag');

  it('hashes the ordered photo hashes, one per line', () => {
    expect(photoSetHash([a, b])).toBe(sha256Hex(`${a}\n${b}\n`));
    expect(photoSetHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the order and the membership of the photos', () => {
    expect(photoSetHash([a, b])).not.toBe(photoSetHash([b, a]));
    expect(photoSetHash([a])).not.toBe(photoSetHash([a, b]));
  });

  it('rejects anything that is not a lowercase sha256', () => {
    expect(() => photoSetHash([a.toUpperCase()])).toThrow(TypeError);
    expect(() => photoSetHash(['abc'])).toThrow(TypeError);
  });

  it('hashes request images by their bytes', () => {
    expect(photoSetHashOfImages([image('front'), image('tag')])).toBe(photoSetHash([a, b]));
  });
});
