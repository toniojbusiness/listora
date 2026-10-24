import { describe, expect, it } from 'vitest';

import { pixelSha256 } from './png.ts';
import { renderTag } from './render.ts';

const blocks = [{ text: 'SIZE M' }, { text: 'MADE IN CHINA' }, { barcode: '036000291452' }];

describe('renderTag', () => {
  it('is deterministic', () => {
    expect(pixelSha256(renderTag(blocks, 'hang_tag'))).toBe(
      pixelSha256(renderTag(blocks, 'hang_tag')),
    );
  });

  it('sizes the tag to its content and draws ink on paper', () => {
    const short = renderTag([{ text: 'M' }], 'neck_label');
    const long = renderTag(
      [{ text: 'MADE IN CHINA / FABRIQUE EN CHINE / HECHO EN CHINA' }],
      'care_label',
    );
    expect(short.width).toBe(360);
    expect(long.width).toBeGreaterThan(short.width);
    const tall = renderTag(blocks, 'care_label');
    expect(tall.height).toBeGreaterThan(short.height);
    expect(new Set(tall.pixels)).toEqual(new Set([250, 196, 28]));
  });

  it('punches a hole in hang tags only', () => {
    const hang = renderTag(blocks, 'hang_tag');
    const care = renderTag(blocks, 'care_label');
    expect(hang.height).toBeGreaterThan(care.height);
    expect(pixelSha256(hang)).not.toBe(pixelSha256(care));
  });
});
