import { describe, expect, it } from 'vitest';

import { feeTableByVersion, feeTableFor, feeTableForSale, FEE_TABLES } from './fee-tables.ts';
import { estimateFeeLines, estimateFeesCents, type FeeTable } from './fees.ts';

const ON = new Date('2026-10-24T12:00:00Z');
const fees = (marketplace: FeeTable['marketplace'], priceCents: number) =>
  estimateFeesCents(feeTableFor(marketplace, ON), priceCents);

describe('fee tables', () => {
  it('estimate eBay: 13.6% up to $7,500, 2.35% above, plus $0.30 / $0.40 per order', () => {
    expect(fees('ebay', 999)).toBe(136 + 30); // 135.864 rounds up
    expect(fees('ebay', 1000)).toBe(136 + 30); // $10.00 or less: $0.30
    expect(fees('ebay', 1001)).toBe(137 + 40); // over $10.00: $0.40
    expect(fees('ebay', 750_000)).toBe(102_000 + 40);
    expect(fees('ebay', 800_000)).toBe(102_000 + 1_175 + 40); // 2.35% of the $500 over
  });

  it('name each rule of an estimate, so a sale records one fee line per rule', () => {
    expect(estimateFeeLines(feeTableFor('ebay', ON), 4500)).toEqual([
      { name: 'Final value fee', kind: 'marketplace', amountCents: 612 },
      { name: 'Per-order fee', kind: 'marketplace', amountCents: 40 },
    ]);
    expect(estimateFeeLines(feeTableFor('depop', ON), 4500)).toEqual([
      { name: 'Transaction fee', kind: 'payment', amountCents: 194 },
    ]);
  });

  it('estimate Poshmark: $2.95 under $15, 20% at $15 or more', () => {
    expect(fees('poshmark', 100)).toBe(295);
    expect(fees('poshmark', 1499)).toBe(295);
    expect(fees('poshmark', 1500)).toBe(300);
    expect(fees('poshmark', 5000)).toBe(1000);
    expect(fees('poshmark', 1501)).toBe(301); // 300.2 rounds up
  });

  it('estimate Mercari: a flat 10% selling fee', () => {
    expect(fees('mercari', 2000)).toBe(200);
    expect(fees('mercari', 2005)).toBe(201);
  });

  it('estimate Depop US: the transaction fee only (buyers pay the Depop fee)', () => {
    expect(fees('depop', 2000)).toBe(66 + 45);
  });

  it('have one current table per marketplace, each with a unique version', () => {
    for (const marketplace of ['ebay', 'depop', 'poshmark', 'mercari'] as const) {
      expect(feeTableFor(marketplace, ON).marketplace).toBe(marketplace);
    }
    const versions = FEE_TABLES.map((table) => table.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(feeTableByVersion('mercari-us-2025-01-06')?.marketplace).toBe('mercari');
    expect(feeTableByVersion('nope')).toBeUndefined();
  });

  it('cite an official https page and the day each table was checked', () => {
    const officialHosts: Record<FeeTable['marketplace'], RegExp> = {
      ebay: /^www\.ebay\.com$/,
      depop: /(^|\.)depop\.com$/,
      poshmark: /(^|\.)poshmark\.com$/,
      mercari: /^www\.mercari\.com$/,
    };
    for (const table of FEE_TABLES) {
      const url = new URL(table.sourceUrl);
      expect(url.protocol, table.version).toBe('https:');
      expect(url.hostname, table.version).toMatch(officialHosts[table.marketplace]);
      expect(table.verifiedOn, table.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(table.effectiveFrom, table.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(table.version, table.version).toBe(`${table.marketplace}-us-${table.effectiveFrom}`);
    }
    // The Mercari schedule was required to be verified against Mercari's help pages.
    const mercari = feeTableFor('mercari', ON);
    expect(mercari).toMatchObject({
      sourceUrl: 'https://www.mercari.com/us/help_center/article/169/',
      verifiedOn: '2026-10-24',
      verified: true,
    });
  });

  it('have bands that start at 0 and are sorted', () => {
    for (const table of FEE_TABLES) {
      for (const rule of table.rules) {
        expect(rule.bands[0]?.fromCents, `${table.version} ${rule.name}`).toBe(0);
        const starts = rule.bands.map((band) => band.fromCents);
        expect(starts, `${table.version} ${rule.name}`).toEqual([...starts].sort((a, b) => a - b));
      }
    }
  });

  // computeFloor relies on both: fees never fall as the price rises, and they rise slower
  // than the price, so a higher price always keeps at least as much.
  it('never decrease as the price rises, and grow slower than the price', () => {
    const prices = [
      ...Array.from({ length: 30_001 }, (_, cents) => cents),
      ...Array.from({ length: 2_000 }, (_, step) => 30_000 + step * 997),
      749_999,
      750_000,
      750_001,
      750_002,
      10_000_000,
    ].sort((a, b) => a - b);
    for (const table of FEE_TABLES) {
      // One expect per table, not per price: 32,000 expect calls made this test slow enough to
      // time out on a loaded machine.
      const falls: string[] = [];
      let previous = estimateFeesCents(table, prices[0] ?? 0);
      for (const price of prices.slice(1)) {
        const current = estimateFeesCents(table, price);
        if (current < previous)
          falls.push(`${String(price)}: ${String(previous)} -> ${String(current)}`);
        previous = current;
      }
      expect(falls, table.version).toEqual([]);
      const span = 1_000_000;
      expect(estimateFeesCents(table, 2 * span) - estimateFeesCents(table, span)).toBeLessThan(
        span,
      );
    }
  });

  it('pick the latest table whose day has come, and refuse a day before every table', () => {
    expect(feeTableFor('mercari', new Date('2025-01-06T00:00:00Z')).version).toBe(
      'mercari-us-2025-01-06',
    );
    expect(() => feeTableFor('mercari', new Date('2025-01-05T23:59:59Z'))).toThrow(
      /no mercari fee table/,
    );
  });

  it('pick the table a sale was charged under, else the marketplace’s first table', () => {
    const later = {
      ...feeTableFor('mercari', ON),
      version: 'mercari-later',
      effectiveFrom: '2026-11-01',
    };
    const tables = [...FEE_TABLES, later];
    expect(feeTableForSale('mercari', new Date('2026-11-01T00:00:00Z'), tables)).toBe(later);
    expect(feeTableForSale('mercari', new Date('2026-10-31T23:59:59Z'), tables).version).toBe(
      'mercari-us-2025-01-06',
    );
    // Before every table: the oldest schedule, not an error.
    expect(feeTableForSale('mercari', new Date('2024-06-01T00:00:00Z'), tables).version).toBe(
      'mercari-us-2025-01-06',
    );
    expect(feeTableForSale('ebay', new Date('2025-06-01T00:00:00Z')).version).toBe(
      'ebay-us-2026-10-24',
    );
  });

  it('reject a price that is not whole non-negative cents', () => {
    const table = feeTableFor('mercari', ON);
    expect(() => estimateFeesCents(table, -1)).toThrow(RangeError);
    expect(() => estimateFeesCents(table, 10.5)).toThrow(RangeError);
  });
});
