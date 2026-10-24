import { TAG_FIELDS } from '@listora/tag-parse';

import type { EvalReport, SystemReport } from './harness.ts';

/** Renders the report as a plain-text table for the terminal. */
export function formatReport(report: EvalReport, options: { mismatches?: boolean } = {}): string {
  const { corpus, systems } = report;
  const lines = [
    `Tag eval: ${String(corpus.items)} items from ${corpus.name} ` +
      `(generator v${String(corpus.generatorVersion)}, seed ${String(corpus.seed)})`,
    '',
    ...systems.map((system) => `  ${system.id}: ${system.description}`),
    '',
  ];

  const systemHeader = ['', ...systems.flatMap((system) => [system.id, '', ''])];
  const header = ['field', ...systems.flatMap(() => ['accuracy', 'precision', 'recall'])];
  const rows: string[][] = TAG_FIELDS.map((field) => [
    field,
    ...systems.flatMap((system) => {
      const metrics = system.fields[field];
      return [
        `${percent(metrics.accuracy)} (${String(metrics.correct)}/${String(metrics.items)})`,
        optionalPercent(metrics.precision),
        optionalPercent(metrics.recall),
      ];
    }),
  ]);
  rows.push(['overall', ...systems.flatMap((system) => [percent(system.overallAccuracy), '', ''])]);
  rows.push([
    'cost/item',
    ...systems.flatMap((system) => [dollars(system.costMicrosPerItem), '', '']),
  ]);
  rows.push([
    'cost total',
    ...systems.flatMap((system) => [dollars(system.costMicrosTotal), '', '']),
  ]);
  rows.push(['errors', ...systems.flatMap((system) => [String(system.errors.length), '', ''])]);
  lines.push(...table([systemHeader, header, ...rows]));

  for (const system of systems) {
    for (const error of system.errors) {
      lines.push('', `${system.id} failed on ${error.caseId}: ${error.message}`);
    }
    if (options.mismatches === true) lines.push(...formatMismatches(system));
  }
  return `${lines.join('\n')}\n`;
}

function formatMismatches(system: SystemReport): string[] {
  if (system.mismatches.length === 0) return [];
  return [
    '',
    `${system.id} mismatches:`,
    ...system.mismatches.map(
      ({ caseId, field, expected, actual }) =>
        `  ${caseId} ${field}: expected [${expected.join(', ')}] got [${actual.join(', ')}]`,
    ),
  ];
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows.reduce<number[]>(
    (max, row) => row.map((cell, i) => Math.max(max[i] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function optionalPercent(value: number | null): string {
  return value === null ? 'n/a' : percent(value);
}

/** Micro-dollars to dollars, at the display edge only. */
function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}
