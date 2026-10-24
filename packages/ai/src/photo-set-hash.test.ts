import { photoSetHash, sha256Hex } from '@listora/shared';
import { describe, expect, it } from 'vitest';

import { photoSetHashOfImages } from './photo-set-hash.ts';
import { image } from './test-support.ts';

describe('photoSetHashOfImages', () => {
  it('hashes request images by their bytes', () => {
    expect(photoSetHashOfImages([image('front'), image('tag')])).toBe(
      photoSetHash([sha256Hex('front'), sha256Hex('tag')]),
    );
  });
});
