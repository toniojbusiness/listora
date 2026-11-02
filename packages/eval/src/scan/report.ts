import type {
  CallScores,
  EstimateScores,
  ItemResult,
  OwnHistoryScores,
  ScanBacktestReport,
} from './backtest.ts';

/**
 * Renders the backtest for the terminal. Only counts and money: no title, brand, or photo of
 * any item, so the output of a private set can be shared. `items: true` adds one line per item
 * (its id, sale, payout, and calls), still without titles.
 */
export function formatScanReport(
  report: ScanBacktestReport,
  options: { items?: boolean } = {},
): string {
  const { dataset, settings } = report;
  const lines = [
    `Scan backtest: ${String(dataset.items)} sold items (${dataset.description})`,
    `  median sale ${money(dataset.medianSalePriceCents)}, median payout after fees ` +
      money(dataset.medianPayoutCents),
    dataset.feeCalibration === null
      ? '  fees: the Depop fee table (too few actual fees to calibrate it)'
      : `  fees: ${String(dataset.feeCalibration.sales)} items' actual fees are ` +
        `${ratio(dataset.feeCalibration.actualFeesCents, dataset.feeCalibration.estimatedFeesCents)}x ` +
        `the Depop fee table's estimate; payouts use the calibrated table`,
    `  call settings: worth listing ${money(settings.worthListingCents)}, at least ` +
      `${String(settings.minComparisons)} of your sales for a range, ` +
      `${String(settings.highComparisons)} for high confidence`,
    '',
  ];

  if (report.reader !== null && report.read !== null) {
    const read = report.read;
    lines.push(
      `AI read: ${report.reader.id}: ${report.reader.description}`,
      `  scanned ${String(read.scanned)}, failed ${String(read.failed)}; cost ` +
        `${dollars(read.costMicrosPerScan)}/scan, ${dollars(read.costMicrosTotal)} total; ` +
        `latency p50 ${seconds(read.latencyP50Ms)}, p95 ${seconds(read.latencyP95Ms)}`,
      `  brand: named ${share(read.brand.named, read.brand.labeled)} of labeled, ` +
        `agreed ${share(read.brand.agreed, read.brand.labeled)}`,
      `  category: named ${share(read.category.named, read.category.labeled)} of labeled, ` +
        `same path ${share(read.category.agreed, read.category.labeled)}, ` +
        `same top category ${share(read.category.sameTop, read.category.labeled)}`,
      `  AI estimate: ${estimate(read.estimate, 'low to high')}`,
      '',
    );
  }

  lines.push("Own history (leave-one-out: each item against the set's other sales):");
  for (const scores of report.ownHistory)
    lines.push(...ownHistoryLines(scores, report.dataset.items));
  lines.push('');

  if (report.prices.length > 0) {
    lines.push(
      "Prices against the sale (before: as the AI and the web gave them; after: the read's brand",
      "snapped to the seller's own and the prices scaled by the other items' sale-to-asking ratio):",
    );
    lines.push(
      ...table([
        ['group', 'variant', 'items', 'AI estimate', 'web asks', 'own sales', 'the call'],
        ...report.prices.map((scores) => [
          scores.group,
          scores.variant,
          String(scores.items),
          priceCell(scores.aiEstimate),
          priceCell(scores.webAsks),
          priceCell(scores.ownSales),
          priceCell(scores.call),
        ]),
      ]),
      '  each: sale inside the range / priced, median error (bias)',
      '',
    );
  }

  lines.push(`The call at worth listing ${money(settings.worthListingCents)}:`);
  lines.push(...table([callHeader(), ...report.calls.map(callRow)]));
  lines.push('');

  lines.push('Worth-listing sweep (items worth it: payout at least the amount):');
  const worthShare = new Map(
    dataset.worthShare.map((entry) => [entry.worthListingCents, entry.items]),
  );
  lines.push(
    ...table([
      ['worth', 'worth it', ...callHeader()],
      ...report.sweep.map((scores) => [
        money(scores.worthListingCents),
        share(worthShare.get(scores.worthListingCents) ?? 0, dataset.items),
        ...callRow(scores),
      ]),
    ]),
  );

  if (options.items === true) {
    lines.push('', 'Items:');
    for (const item of report.items) lines.push(itemLine(item));
  }
  return `${lines.join('\n')}\n`;
}

function ownHistoryLines(scores: OwnHistoryScores, items: number): string[] {
  const { byLevel } = scores;
  return [
    `  ${scores.variant}: a range for ${share(
      byLevel.brand_and_category + byLevel.brand + byLevel.category,
      items,
    )} (brand and category ${String(byLevel.brand_and_category)}, brand ` +
      `${String(byLevel.brand)}, category ${String(byLevel.category)}); thin ` +
      `${String(scores.thin)}, none ${String(scores.none)}`,
    `    quartiles: ${estimate(scores.estimate, 'low to high quartile')}`,
  ];
}

function callHeader(): string[] {
  return ['variant', 'buy', 'your call', 'skip', 'buy held', 'skip held', 'high/med/low'];
}

function callRow(scores: CallScores): string[] {
  const { counts, byConfidence } = scores;
  return [
    scores.variant,
    String(counts.buy),
    String(counts.your_call),
    String(counts.skip),
    counts.buy === 0 ? '-' : share(scores.buyHeld, counts.buy),
    counts.skip === 0 ? '-' : share(scores.skipHeld, counts.skip),
    `${String(byConfidence.high)}/${String(byConfidence.medium)}/${String(byConfidence.low)}`,
  ];
}

function itemLine(item: ItemResult): string {
  const calls = Object.entries(item.calls)
    .map(([source, result]) => `${source} ${result.call.call} (${result.call.confidence})`)
    .join(', ');
  const read =
    item.read === undefined
      ? ''
      : item.read.ok
        ? item.read.scan.aiEstimate === null
          ? '; AI no price'
          : `; AI ${money(item.read.scan.aiEstimate.lowCents)}-${money(item.read.scan.aiEstimate.highCents)}`
        : '; AI failed';
  return `  ${item.id}: sold ${money(item.salePriceCents)}, payout ${money(item.payoutCents)}${read}; ${calls}`;
}

function estimate(scores: EstimateScores, range: string): string {
  if (scores.priced === 0) return 'no ranges';
  return (
    `sale price inside the ${range} ${share(scores.saleInRange, scores.priced)}; ` +
    `median error ${percent(scores.medianAbsError)} (bias ${signedPercent(scores.medianError)})`
  );
}

/** "8/14 57% 31% (+4%)": the sale inside the range of those priced, then the error and bias. */
function priceCell(scores: EstimateScores): string {
  if (scores.priced === 0) return '-';
  return (
    `${String(scores.saleInRange)}/${String(scores.priced)} ` +
    `${percent(scores.saleInRange / scores.priced)} ${percent(scores.medianAbsError)} ` +
    `(${signedPercent(scores.medianError)})`
  );
}

function share(part: number, whole: number): string {
  if (whole === 0) return '0/0';
  return `${String(part)}/${String(whole)} (${percent(part / whole)})`;
}

function percent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(0)}%`;
}

function signedPercent(value: number | null): string {
  if (value === null) return '-';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`;
}

function ratio(part: number, whole: number): string {
  return whole === 0 ? '-' : (part / whole).toFixed(2);
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(5)}`;
}

function seconds(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows.reduce<number[]>(
    (max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    `  ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')}`.trimEnd(),
  );
}
