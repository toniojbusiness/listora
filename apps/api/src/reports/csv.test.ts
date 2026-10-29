import { describe, expect, it } from 'vitest';

import { csvFile, dollars, integer } from './csv.ts';

describe('the CSV files', () => {
  it('writes cents as plain decimal dollars, negatives too', () => {
    expect(dollars(0)?.csvNumber).toBe('0.00');
    expect(dollars(5)?.csvNumber).toBe('0.05');
    expect(dollars(167)?.csvNumber).toBe('1.67');
    expect(dollars(123_456)?.csvNumber).toBe('1234.56');
    expect(dollars(-305)?.csvNumber).toBe('-3.05');
    expect(dollars(-5)?.csvNumber).toBe('-0.05');
    expect(dollars(null)).toBeNull();
  });

  it('starts with a byte order mark and ends every row with CRLF', () => {
    expect(
      csvFile(
        ['A', 'B'],
        [
          ['x', integer(2)],
          [null, dollars(-100)],
        ],
      ),
    ).toBe('﻿A,B\r\nx,2\r\n,-1.00\r\n');
  });

  it('quotes cells with commas, quotes, line breaks, or edge spaces', () => {
    expect(csvFile(['A'], [["Levi's, 501"], ['12" inseam'], ['two\nlines'], [' padded']])).toBe(
      '﻿A\r\n"Levi\'s, 501"\r\n"12"" inseam"\r\n"two\nlines"\r\n" padded"\r\n',
    );
  });

  it('keeps text a spreadsheet would run as a formula as text, but not numbers', () => {
    const file = csvFile(
      ['A'],
      [['=1+2'], ['+1'], ['-1'], ['@SUM(A1)'], ['\tx'], ['=HYPERLINK("x")'], [dollars(-1)]],
    );
    expect(file.split('\r\n').slice(1, -1)).toEqual([
      "'=1+2",
      "'+1",
      "'-1",
      "'@SUM(A1)",
      "'\tx",
      `"'=HYPERLINK(""x"")"`,
      '-0.01',
    ]);
  });
});
