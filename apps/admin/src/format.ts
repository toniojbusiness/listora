import type { UsagePeriod } from '@listora/ai';

/** Micro-dollars as exact dollars, `$1.234567`, without floating point. */
export function formatMicros(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000).padStart(6, '0');
  return `${sign}$${whole.toLocaleString('en-US')}.${fraction}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** A count with its noun, singular for exactly one: `1 call`, `2 calls`. */
export function formatQuantity(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

/** `part / whole` as a percentage with one decimal; a dash when `whole` is zero. */
export function formatShare(part: number, whole: number): string {
  return whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`;
}

export function describePeriod(period: UsagePeriod): string {
  return period.kind === 'day' ? `${period.day} (UTC day)` : `${period.month} (UTC month)`;
}

/**
 * A plain-text table: columns padded to their widest cell, numbers aligned right. Lines carry
 * no trailing spaces.
 */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  rightAligned: readonly number[] = [],
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => {
        const width = widths[column] ?? cell.length;
        return rightAligned.includes(column) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** Label/value lines with the values in one column. */
export function formatFields(fields: readonly (readonly [label: string, value: string])[]): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}
