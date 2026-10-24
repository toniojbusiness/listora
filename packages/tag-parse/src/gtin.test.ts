import { describe, expect, it } from 'vitest';

import { gtinCheckDigit, isValidGtin, parseBarcodeGtins, parseOcrGtins, toGtin } from './gtin.ts';
import { prepareLines } from './normalize.ts';

const lines = (...texts: string[]) => prepareLines(texts.map((text) => ({ text })));

describe('GS1 check digit', () => {
  it.each([
    ['03600029145', 2],
    ['590123412345', 7],
    ['400638133393', 1],
    ['01234567890', 5],
  ])('computes the check digit of %s as %i', (body, check) => {
    expect(gtinCheckDigit(body)).toBe(check);
  });

  it('rejects a body that is not digits', () => {
    expect(() => gtinCheckDigit('12A4')).toThrow(RangeError);
  });

  it('accepts only 12- or 13-digit codes with a correct check digit', () => {
    expect(isValidGtin('036000291452')).toBe(true);
    expect(isValidGtin('5901234123457')).toBe(true);
    expect(isValidGtin('036000291453')).toBe(false);
    expect(isValidGtin('5901234123450')).toBe(false);
    expect(isValidGtin('12345670')).toBe(false); // EAN-8 is out of scope
    expect(isValidGtin('03600029145a')).toBe(false);
  });

  it('reports an EAN-13 with a leading zero as the UPC-A it encodes', () => {
    expect(toGtin('0036000291452')).toEqual({ format: 'upc_a', digits: '036000291452' });
    expect(toGtin('5901234123457')).toEqual({ format: 'ean_13', digits: '5901234123457' });
    expect(toGtin('5901234123450')).toBeNull();
  });
});

describe('barcode payloads', () => {
  it('reads EAN-13 and UPC-A payloads with full confidence and the barcode as source', () => {
    const parsed = parseBarcodeGtins([
      { payload: '0036000291452', symbology: 'VNBarcodeSymbologyEAN13', photoId: 'p1' },
      { payload: '5901234123457', symbology: 'EAN-13' },
      { payload: '036000291452', symbology: 'org.gs1.UPC-A' },
    ]);
    expect(parsed.map((p) => p.value)).toEqual([
      { format: 'upc_a', digits: '036000291452' },
      { format: 'ean_13', digits: '5901234123457' },
      { format: 'upc_a', digits: '036000291452' },
    ]);
    expect(parsed[0]).toMatchObject({
      confidence: 0.99,
      source: { kind: 'barcode', barcodeIndex: 0, photoId: 'p1' },
    });
  });

  it('ignores invalid check digits, wrong lengths, and non-retail symbologies', () => {
    expect(
      parseBarcodeGtins([
        { payload: '0036000291453', symbology: 'VNBarcodeSymbologyEAN13' },
        { payload: '036000291452', symbology: 'VNBarcodeSymbologyEAN13' },
        { payload: '01234565', symbology: 'VNBarcodeSymbologyUPCE' },
        { payload: 'https://example.com/p/1', symbology: 'VNBarcodeSymbologyQR' },
        { payload: '036000291452', symbology: 'VNBarcodeSymbologyCode128' },
      ]),
    ).toEqual([]);
  });

  it('infers the format from the length when no symbology is given', () => {
    expect(parseBarcodeGtins([{ payload: '036000291452' }]).map((p) => p.value)).toEqual([
      { format: 'upc_a', digits: '036000291452' },
    ]);
  });
});

describe('printed barcode digits', () => {
  it('reads UPC-A and EAN-13 human-readable groupings', () => {
    const parsed = parseOcrGtins(lines('0 36000 29145 2', '5 901234 123457', 'UPC 036000291452'));
    expect(parsed.map((p) => p.value.digits)).toEqual([
      '036000291452',
      '5901234123457',
      '036000291452',
    ]);
    expect(parsed.map((p) => p.confidence)).toEqual([0.85, 0.85, 0.9]);
    expect(parsed[1]?.source).toMatchObject({ kind: 'ocr', lineIndexes: [1] });
  });

  it('rejects digit runs with a bad check digit or an unusual grouping', () => {
    expect(parseOcrGtins(lines('0 36000 29145 3', '0360 0029 1452', 'RN 12345 6789012'))).toEqual(
      [],
    );
  });
});
