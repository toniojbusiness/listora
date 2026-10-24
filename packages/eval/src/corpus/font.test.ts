import { describe, expect, it } from 'vitest';

import { FONT_CHARACTERS, GLYPH_HEIGHT, GLYPH_WIDTH, glyph, glyphSource } from './font.ts';
import { renderTag } from './render.ts';

describe('corpus font', () => {
  it('defines every glyph on the 5-column grid with 7 to 9 rows', () => {
    for (const char of FONT_CHARACTERS) {
      const rows = glyphSource(char)?.split(' ') ?? [];
      expect(rows.length, char).toBeGreaterThanOrEqual(7);
      expect(rows.length, char).toBeLessThanOrEqual(GLYPH_HEIGHT);
      for (const row of rows) expect(row, char).toMatch(/^[.#]{5}$/);
      expect(glyph(char)).toHaveLength(GLYPH_HEIGHT);
      expect(glyph(char).every((row) => row.length === GLYPH_WIDTH)).toBe(true);
    }
  });

  it('covers letters, digits, and the punctuation tags use', () => {
    for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;-/%#()$+'|") {
      expect(FONT_CHARACTERS, char).toContain(char);
    }
  });

  it('gives every visible character some ink and keeps glyphs distinct', () => {
    const shapes = FONT_CHARACTERS.filter((char) => char !== ' ').map((char) => glyphSource(char));
    expect(shapes.every((shape) => shape?.includes('#'))).toBe(true);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('refuses to render a character it has no glyph for', () => {
    expect(() => glyph('&')).toThrow(/no glyph/);
    expect(() => renderTag([{ text: 'FIELD & FERN' }], 'care_label')).toThrow(/no glyph/);
  });
});
