import { describe, expect, it } from 'vitest';

import { simulateOcr, type GenBlock } from './noise.ts';
import { createRandom } from './random.ts';

/** Runs the model over many seeds and collects every distinct OCR line it produced. */
function outcomes(blocks: readonly GenBlock[], seeds = 400): Set<string> {
  const seen = new Set<string>();
  for (let seed = 0; seed < seeds; seed += 1) {
    const { lines } = simulateOcr(blocks, createRandom(seed));
    seen.add(lines.map((line) => line.text).join(' | '));
  }
  return seen;
}

describe('OCR noise model', () => {
  it('confuses digits, splits after the label, and otherwise reads the line exactly', () => {
    const seen = outcomes([{ kind: 'line', text: 'RN 150722', role: 'rn' }]);
    expect(seen).toContain('RN 150722');
    expect(seen).toContain('RN | 150722');
    expect([...seen].some((text) => /RN [0-9OISlB]{6}$/.test(text) && text !== 'RN 150722')).toBe(
      true,
    );
  });

  it('wraps "MADE IN" and merges safe neighbors without crossing a wrap', () => {
    const seen = outcomes(
      [
        { kind: 'line', text: 'MADE IN CHINA', role: 'origin' },
        { kind: 'line', text: 'RN 41235', role: 'rn' },
      ],
      3000,
    );
    expect(seen).toContain('MADE IN | CHINA | RN 41235');
    expect(seen).toContain('MADE IN CHINA RN 41235');
    expect(seen).toContain('MADE IN | CHINA RN 41235');
    expect([...seen].some((text) => text.startsWith('MADE IN RN'))).toBe(false);
  });

  it('never merges a bare size line, which would hide it', () => {
    const seen = outcomes([
      { kind: 'line', text: 'M', role: 'size_bare' },
      { kind: 'line', text: 'MADE IN CHINA', role: 'origin' },
    ]);
    expect([...seen].every((text) => text.startsWith('M | '))).toBe(true);
  });

  it('reports a decoded UPC-A the way Vision does and never decodes an invalid code', () => {
    const decodedReads = Array.from({ length: 200 }, (_, seed) =>
      simulateOcr([{ kind: 'barcode', digits: '036000291452', valid: true }], createRandom(seed)),
    ).flatMap((read) => read.barcodes);
    expect(decodedReads.length).toBeGreaterThan(150);
    for (const read of decodedReads) {
      expect(read).toEqual({ payload: '0036000291452', symbology: 'VNBarcodeSymbologyEAN13' });
    }
    for (let seed = 0; seed < 200; seed += 1) {
      const invalid = simulateOcr(
        [{ kind: 'barcode', digits: '036000291453', valid: false }],
        createRandom(seed),
      );
      expect(invalid.barcodes).toEqual([]);
      expect(invalid.lines.map((line) => line.text)).toEqual(['0 36000 29145 3']);
    }
  });

  it('marks changed lines with lower OCR confidence', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const { lines } = simulateOcr(
        [{ kind: 'line', text: '60% COTTON 40% POLYESTER', role: 'fiber' }],
        createRandom(seed),
      );
      const changed = lines.length !== 1 || lines[0]?.text !== '60% COTTON 40% POLYESTER';
      expect(lines.every((line) => line.confidence === (changed ? 0.5 : 1))).toBe(true);
    }
  });
});
