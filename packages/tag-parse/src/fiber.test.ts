import { describe, expect, it } from 'vitest';

import { parseFibers } from './fiber.ts';
import { prepareLines } from './normalize.ts';

const parse = (...texts: string[]) => parseFibers(prepareLines(texts.map((text) => ({ text }))));
const fibersOf = (...texts: string[]) =>
  parse(...texts).map(
    ({ value }) => `${value.part ?? '-'}:${value.material}:${String(value.percent)}`,
  );

describe('fiber parsing', () => {
  it.each([
    ['100% COTTON', ['-:cotton:100']],
    ['100% Cotton', ['-:cotton:100']],
    ['60% COTTON 40% POLYESTER', ['-:cotton:60', '-:polyester:40']],
    ['60% COTTON, 40% POLYESTER', ['-:cotton:60', '-:polyester:40']],
    ['60%COTTON/40%POLYESTER', ['-:cotton:60', '-:polyester:40']],
    ['COTTON 60% POLYESTER 40%', ['-:cotton:60', '-:polyester:40']],
    ['COTTON60% POLYESTER40%', ['-:cotton:60', '-:polyester:40']],
    ['95% COTTON 5% ELASTANE', ['-:cotton:95', '-:spandex:5']],
    ['60% COTTON / COTON / ALGODON 40% POLYESTER', ['-:cotton:60', '-:polyester:40']],
    ['70% MERINO WOOL 30% NYLON', ['-:merino_wool:70', '-:nylon:30']],
    ['95% COTTON 5% OTHER FIBERS', ['-:cotton:95', '-:other:5']],
    ['80% LANA / WOOL 20% NAILON / NYLON', ['-:wool:80', '-:nylon:20']],
    ['55% LIN 45% COTON', ['-:linen:55', '-:cotton:45']],
    ['100% COTTON EXCLUSIVE OF TRIM', ['-:cotton:100']],
    ['SHELL: 100% NYLON LINING: 100% POLYESTER', ['shell:nylon:100', 'lining:polyester:100']],
    ['SHELL/EXTERIOR: 100% NYLON', ['shell:nylon:100']],
    ['LINING 100% POLYESTER', ['lining:polyester:100']],
  ])('reads %j', (text, expected) => {
    expect(fibersOf(text)).toEqual(expected);
  });

  it('collapses a composition repeated in several languages', () => {
    expect(
      fibersOf('60% COTTON 40% POLYESTER', '60% COTON 40% POLYESTER', '60% ALGODON 40% POLIESTER'),
    ).toEqual(['-:cotton:60', '-:polyester:40']);
  });

  it('carries a part label onto the lines that continue its composition', () => {
    expect(fibersOf('SHELL', '60% COTTON', '40% POLYESTER', 'LINING:', '100% ACETATE')).toEqual([
      'shell:cotton:60',
      'shell:polyester:40',
      'lining:acetate:100',
    ]);
  });

  it('drops a part label at the first line that is not about fibers', () => {
    expect(fibersOf('LINING', 'MADE IN CHINA', '100% COTTON')).toEqual(['-:cotton:100']);
  });

  it('repairs OCR misreads in percentages and material names at lower confidence', () => {
    const parsed = parse('1O0% C0TTON');
    expect(parsed.map(({ value }) => value)).toEqual([
      { part: null, material: 'cotton', percent: 100 },
    ]);
    expect(parsed[0]?.confidence).toBe(0.85);
    expect(fibersOf('60% COTTOH 40% POLYFSTER')).toEqual(['-:cotton:60', '-:polyester:40']);
  });

  it('marks an incomplete composition as low confidence', () => {
    expect(parse('100% COTTON')[0]?.confidence).toBe(0.95);
    expect(parse('60% COTTON')[0]?.confidence).toBe(0.6);
  });

  it('never pairs a percentage with the wrong material when a % sign is lost', () => {
    expect(fibersOf('97 VISCOSE / 3% METALLIC')).toEqual(['-:metallic:3']);
    expect(fibersOf('97 VISCOSE')).toEqual([]);
  });

  it.each([
    'MACHINE WASH COLD',
    'MODEL 12345',
    'COTTON',
    '50% OFF',
    '150% COTTON',
    'TRIM',
    'WOOL CYCLE 30',
  ])('finds no fiber content in %j', (text) => {
    expect(fibersOf(text)).toEqual([]);
  });
});
