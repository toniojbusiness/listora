/**
 * The API latency benchmark (docs/features/performance.md): a synthetic 2,000-item seller on
 * a scratch database, then each screen's read endpoints called in turn, reporting p50, p95,
 * and the number of SQL statements per request. Run it with `npm run perf:api` (options:
 * `--items`, `--other-sellers`, `--iterations`, `--only <name parts, comma-separated>`, `--json <file>`).
 *
 * The app is the real one (`buildApp` through the integration tests' `createTestApi`), driven
 * with `inject`, so the numbers include routing, validation, auth, the queries, and the
 * serialization, but not the network.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import type { OperationId } from '../contract/routes.ts';
import { createTestApi, type CallOptions, type TestApi } from '../test-support.ts';
import { seedSyntheticSeller, type SyntheticSellerCounts } from './seed.ts';
import { countStatements } from './statements.ts';

const statements = countStatements();

export interface Scenario {
  name: string;
  operationId: OperationId;
  options: (fixture: BenchFixture) => CallOptions;
}

export interface BenchFixture {
  token: string;
  listedItemId: string;
  soldItemId: string;
  saleId: string;
  page5Cursor: string;
  today: string;
}

export interface ScenarioResult {
  name: string;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  statements: number;
  bytes: number;
}

export const SCENARIOS: readonly Scenario[] = [
  { name: 'Inventory, first page', operationId: 'listItems', options: () => ({}) },
  {
    name: 'Inventory, page 5',
    operationId: 'listItems',
    options: (f) => ({ query: { cursor: f.page5Cursor } }),
  },
  {
    name: 'Inventory, 100 per page',
    operationId: 'listItems',
    options: () => ({ query: { limit: 100 } }),
  },
  {
    name: 'Inventory, search',
    operationId: 'listItems',
    options: () => ({ query: { q: 'fleece' } }),
  },
  {
    name: 'Inventory, listed on eBay',
    operationId: 'listItems',
    options: () => ({ query: { marketplace: 'ebay', status: ['listed'] } }),
  },
  {
    name: 'Inventory, by date listed',
    operationId: 'listItems',
    options: () => ({ query: { sort: 'listed_oldest' } }),
  },
  {
    name: 'Inventory, by price',
    operationId: 'listItems',
    options: () => ({ query: { sort: 'price_high' } }),
  },
  {
    name: 'Inventory, by profit',
    operationId: 'listItems',
    options: () => ({ query: { sort: 'profit_high' } }),
  },
  {
    name: 'Item detail, listed',
    operationId: 'getItem',
    options: (f) => ({ params: { itemId: f.listedItemId } }),
  },
  {
    name: 'Item detail, sold',
    operationId: 'getItem',
    options: (f) => ({ params: { itemId: f.soldItemId } }),
  },
  { name: 'Today', operationId: 'getToday', options: () => ({}) },
  { name: 'Sales feed', operationId: 'listSales', options: () => ({}) },
  {
    name: 'Sales feed, by profit',
    operationId: 'listSales',
    options: () => ({ query: { sort: 'profit_high' } }),
  },
  {
    name: 'Sale detail',
    operationId: 'getSale',
    options: (f) => ({ params: { saleId: f.saleId } }),
  },
  {
    name: 'Profit, last 30 days',
    operationId: 'getProfit',
    options: (f) => ({
      query: { from: shiftDays(f.today, -29), to: f.today, timeZone: 'America/New_York' },
    }),
  },
  {
    name: 'Profit, last 365 days',
    operationId: 'getProfit',
    options: (f) => ({
      query: { from: shiftDays(f.today, -364), to: f.today, timeZone: 'America/New_York' },
    }),
  },
  { name: 'Tasks, open', operationId: 'listTasks', options: () => ({}) },
  { name: 'Operations', operationId: 'listOperations', options: () => ({}) },
  { name: 'Listings', operationId: 'listListings', options: () => ({}) },
  { name: 'Connections', operationId: 'listConnections', options: () => ({}) },
  { name: 'Connection health', operationId: 'getConnectionHealth', options: () => ({}) },
  { name: 'Usage', operationId: 'getUsage', options: () => ({}) },
];

function shiftDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export async function fixtureFor(api: TestApi, token: string): Promise<BenchFixture> {
  const listed = await api.call('listItems', { token, query: { status: ['listed'], limit: 1 } });
  const shipped = await api.call('listItems', { token, query: { status: ['shipped'], limit: 1 } });
  const sales = await api.call('listSales', { token, query: { limit: 1 } });
  let cursor: string | undefined;
  for (let page = 0; page < 4; page += 1) {
    const result = await api.call('listItems', {
      token,
      ...(cursor === undefined ? {} : { query: { cursor } }),
    });
    cursor = result.body.nextCursor;
  }
  const listedItemId = listed.body.data[0]?.id;
  const soldItemId = shipped.body.data[0]?.id;
  const saleId = sales.body.data[0]?.id;
  if (!listedItemId || !soldItemId || !saleId || cursor === undefined) {
    throw new Error('the synthetic seller is missing a listed item, a sold item, or a sale');
  }
  return {
    token,
    listedItemId,
    soldItemId,
    saleId,
    page5Cursor: cursor,
    today: new Date().toISOString().slice(0, 10),
  };
}

export async function runScenario(
  api: TestApi,
  scenario: Scenario,
  fixture: BenchFixture,
  iterations: number,
): Promise<ScenarioResult> {
  const options = { token: fixture.token, ...scenario.options(fixture) };
  const durations: number[] = [];
  let perRequest = 0;
  let bytes = 0;
  for (let i = 0; i < iterations + 5; i += 1) {
    const before = statements();
    const started = performance.now();
    const result = await api.call(scenario.operationId, options);
    const elapsed = performance.now() - started;
    if (result.status !== 200) {
      throw new Error(`${scenario.name} answered ${String(result.status)}`);
    }
    // The first five warm the caches and the compiled validators.
    if (i >= 5) {
      durations.push(elapsed);
      perRequest = statements() - before;
      bytes = JSON.stringify(result.body).length;
    }
  }
  durations.sort((a, b) => a - b);
  return {
    name: scenario.name,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.at(-1) ?? 0,
    statements: perRequest,
    bytes,
  };
}

/** Signs in a seller and seeds them; returns their token and what was seeded. */
export async function seedSeller(
  api: TestApi,
  email: string,
  items: number,
): Promise<{ token: string; counts: SyntheticSellerCounts }> {
  const token = await api.signIn(email);
  const tenant = await api.tenantOf(email);
  const counts = await seedSyntheticSeller(api.db, tenant.accountId, { items });
  return { token, counts };
}

function table(results: readonly ScenarioResult[]): string {
  const lines = [
    '| Endpoint | p50 ms | p95 ms | max ms | SQL statements | Response bytes |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.p50Ms.toFixed(1)} | ${r.p95Ms.toFixed(1)} | ${r.maxMs.toFixed(1)} | ${String(r.statements)} | ${String(r.bytes)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      items: { type: 'string', default: '2000' },
      'other-sellers': { type: 'string', default: '4' },
      iterations: { type: 'string', default: '100' },
      json: { type: 'string' },
      only: { type: 'string' },
    },
  });
  const items = Number(values.items);
  const others = Number(values['other-sellers']);
  const iterations = Number(values.iterations);
  const api = await createTestApi('perf');
  try {
    const started = performance.now();
    const seller = await seedSeller(api, 'perf-seller@listora.test', items);
    // Other tenants in the same tables, so a query that misses its account index shows.
    for (let n = 1; n <= others; n += 1) {
      await seedSeller(api, `perf-other-${String(n)}@listora.test`, items);
    }
    process.stdout.write(
      `Seeded ${String(others + 1)} sellers of ${JSON.stringify(seller.counts)} in ${((performance.now() - started) / 1000).toFixed(1)} s\n`,
    );
    const fixture = await fixtureFor(api, seller.token);
    const results: ScenarioResult[] = [];
    const only = values.only?.toLowerCase().split(',');
    for (const scenario of SCENARIOS) {
      const name = scenario.name.toLowerCase();
      if (only !== undefined && !only.some((part) => name.includes(part.trim()))) continue;
      results.push(await runScenario(api, scenario, fixture, iterations));
      // The test API keeps every log line; a benchmark run does not need them.
      api.logLines.length = 0;
    }
    process.stdout.write(table(results));
    if (values.json !== undefined) {
      await writeFile(
        values.json,
        `${JSON.stringify({ counts: seller.counts, results }, null, 2)}\n`,
      );
    }
  } finally {
    await api.close();
  }
}

if (import.meta.main) await main();
