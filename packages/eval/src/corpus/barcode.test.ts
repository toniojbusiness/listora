import { describe, expect, it } from 'vitest';

import {
  EAN13_MODULES,
  FIRST_DIGIT_PARITY,
  G_CODES,
  L_CODES,
  R_CODES,
  ean13Modules,
  humanReadable,
} from './barcode.ts';

/*
 * The symbol tables are checked against the structural rules of GS1 EAN-13 rather than against
 * a copy of themselves. Rendered fixtures were also confirmed to decode with Apple Vision
 * (`VNDetectBarcodesRequest`) when the corpus was built.
 */

const runs = (code: string) => code.match(/(0+|1+)/g) ?? [];
const ones = (code: string) => code.replace(/0/g, '').length;

describe('EAN-13 symbol tables', () => {
  it('encodes every digit in 7 modules as two bars and two spaces', () => {
    for (const code of [...L_CODES, ...G_CODES, ...R_CODES]) {
      expect(code).toHaveLength(7);
      expect(runs(code)).toHaveLength(4);
    }
  });

  it('gives set A odd parity, set B even parity, and keeps all 30 patterns distinct', () => {
    for (const code of L_CODES) expect(ones(code) % 2).toBe(1);
    for (const code of G_CODES) expect(ones(code) % 2).toBe(0);
    expect(new Set([...L_CODES, ...G_CODES, ...R_CODES]).size).toBe(30);
    expect(L_CODES.every((code) => code.startsWith('0'))).toBe(true);
    expect(R_CODES.every((code) => code.startsWith('1'))).toBe(true);
  });

  it('starts every left half with set A and uses three set B digits otherwise', () => {
    expect(FIRST_DIGIT_PARITY[0]).toBe('LLLLLL');
    for (const parity of FIRST_DIGIT_PARITY.slice(1)) {
      expect(parity.startsWith('L')).toBe(true);
      expect(parity.replace(/L/g, '')).toHaveLength(3);
    }
    expect(new Set(FIRST_DIGIT_PARITY).size).toBe(10);
  });
});

describe('ean13Modules', () => {
  /** Decodes modules back to digits with the same tables, as a reader would. */
  function decode(modules: string): string {
    const left = Array.from({ length: 6 }, (_, i) => modules.slice(3 + i * 7, 10 + i * 7));
    const right = Array.from({ length: 6 }, (_, i) => modules.slice(50 + i * 7, 57 + i * 7));
    const parity = left
      .map((code) => (L_CODES.includes(code as (typeof L_CODES)[number]) ? 'L' : 'G'))
      .join('');
    const first = FIRST_DIGIT_PARITY.indexOf(parity as (typeof FIRST_DIGIT_PARITY)[number]);
    const leftDigits = left.map((code, i) =>
      parity[i] === 'L' ? L_CODES.indexOf(code as (typeof L_CODES)[number]) : G_CODES.indexOf(code),
    );
    return [first, ...leftDigits, ...right.map((code) => R_CODES.indexOf(code))].join('');
  }

  it.each(['5901234123457', '4006381333931', '0036000291452'])('round-trips %s', (code) => {
    const modules = ean13Modules(code);
    expect(modules).toHaveLength(EAN13_MODULES);
    expect(modules.slice(0, 3)).toBe('101');
    expect(modules.slice(45, 50)).toBe('01010');
    expect(modules.slice(92)).toBe('101');
    expect(decode(modules)).toBe(code);
  });

  it('draws a UPC-A as the EAN-13 with a leading zero', () => {
    expect(ean13Modules('036000291452')).toBe(ean13Modules('0036000291452'));
  });

  it('rejects input that is not 12 or 13 digits', () => {
    expect(() => ean13Modules('12345')).toThrow(RangeError);
    expect(() => ean13Modules('03600029145A')).toThrow(RangeError);
  });

  it('prints the standard human-readable groups', () => {
    expect(humanReadable('036000291452')).toBe('0 36000 29145 2');
    expect(humanReadable('5901234123457')).toBe('5 901234 123457');
  });
});
