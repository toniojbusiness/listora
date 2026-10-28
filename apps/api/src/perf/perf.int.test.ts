import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import { SCENARIOS, fixtureFor, runScenario, seedSeller, type BenchFixture } from './bench.ts';
import { countStatements } from './statements.ts';

const statements = countStatements();

describe('performance benchmark (synthetic seller)', () => {
  let api: TestApi;
  let fixture: BenchFixture;

  beforeAll(async () => {
    api = await createTestApi('perf');
    const seller = await seedSeller(api, 'perf-seller@listora.test', 150);
    // A second tenant in the same tables, as in production.
    await seedSeller(api, 'perf-other@listora.test', 150);
    expect(seller.counts).toMatchObject({ items: 150, photos: 900 });
    expect(seller.counts.sales).toBeGreaterThan(0);
    fixture = await fixtureFor(api, seller.token);
  }, 60_000);

  afterAll(async () => {
    await api.close();
  });

  it('answers every benchmark scenario on the synthetic seller', async () => {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(api, scenario, fixture, 1);
      expect(result.statements, scenario.name).toBeGreaterThan(0);
    }
  }, 60_000);

  // An N+1 query shows as statements growing with the page: every list reads its page and
  // what each row shows in a fixed number of statements.
  it.each([
    ['listItems', {}],
    ['listItems', { status: ['listed'], marketplace: 'ebay' }],
    ['listItems', { sort: 'listed_newest' }],
    ['listSales', {}],
    ['listSales', { sort: 'profit_high' }],
    ['listTasks', {}],
    ['listOperations', {}],
    ['listListings', {}],
  ] as const)(
    '%s %j reads a page in the same number of statements at any size',
    async (operationId, query) => {
      const counted = async (limit: number): Promise<number> => {
        const before = statements();
        const result = await api.call(operationId, {
          token: fixture.token,
          query: { ...query, limit },
        });
        expect(result.status).toBe(200);
        expect((result.body as { data: unknown[] }).data.length).toBeGreaterThan(
          limit === 2 ? 1 : 2,
        );
        return statements() - before;
      };
      expect(await counted(100)).toBe(await counted(2));
    },
  );
});
