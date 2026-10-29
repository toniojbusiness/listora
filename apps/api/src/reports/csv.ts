/**
 * CSV files for the exports (docs/features/reports.md): RFC 4180 (commas, double quotes where a
 * cell needs them, CRLF line ends), UTF-8 with a byte order mark so Excel and Numbers read
 * accents right. A text cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, a tab
 * or carriage return first) starts with an apostrophe, so a title such as `=HYPERLINK(...)`
 * stays text; numbers are written as numbers.
 */

/** A number cell, written as is and never guarded. */
export interface CsvNumber {
  readonly csvNumber: string;
}

/** Text, a number, or an empty cell. */
export type CsvCell = string | CsvNumber | null;

const BYTE_ORDER_MARK = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** Integer cents as plain decimal dollars (`-3.05`); empty for null. */
export function dollars(cents: number | null): CsvNumber | null {
  if (cents === null) return null;
  const whole = Math.trunc(Math.abs(cents) / 100);
  const rest = Math.abs(cents) % 100;
  return { csvNumber: `${cents < 0 ? '-' : ''}${String(whole)}.${String(rest).padStart(2, '0')}` };
}

export function integer(value: number): CsvNumber {
  return { csvNumber: String(Math.trunc(value)) };
}

/** The file's text: the header row, then the rows. */
export function csvFile(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(cellText).join(','));
  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
}

function cellText(cell: CsvCell): string {
  if (cell === null) return '';
  if (typeof cell !== 'string') return cell.csvNumber;
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
