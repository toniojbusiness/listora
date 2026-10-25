import { utcMonthPeriod } from '@listora/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import type { Tenant } from '../tenancy.ts';

const OWNER = 'usage.owner@example.com';
const OTHER = 'usage.other@example.com';

describe('usage (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let tenant: Tenant;

  beforeAll(async () => {
    api = await createTestApi('usage');
    token = await api.signIn(OWNER);
    tenant = await api.tenantOf(OWNER);
  });

  afterAll(async () => {
    await api.close();
  });

  const period = () => utcMonthPeriod(new Date(api.clock.now));

  it('reports every quota as unused and unlimited before anything is counted', async () => {
    const response = await api.call('getUsage', { token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      periodStart: period().start,
      periodEnd: period().end,
      quotas: [
        { metric: 'ai_items', used: 0 },
        { metric: 'premium_identifications', used: 0 },
      ],
    });
  });

  it("reports this period's counts and limits, and only the account's own", async () => {
    const { start, end } = period();
    await api.db
      .insertInto('usage_counter')
      .values([
        {
          account_id: tenant.accountId,
          metric: 'premium_identifications',
          period_start: start,
          period_end: end,
          used: 3,
          quota: 10,
        },
        {
          account_id: tenant.accountId,
          metric: 'ai_items',
          period_start: start,
          period_end: end,
          used: 41,
        },
        // Last period's count is not this period's.
        {
          account_id: tenant.accountId,
          metric: 'ai_items',
          period_start: '2020-01-01',
          period_end: '2020-02-01',
          used: 99,
          quota: 100,
        },
      ])
      .execute();

    const response = await api.call('getUsage', { token });
    expect(response.status).toBe(200);
    expect(response.body.quotas).toEqual([
      { metric: 'ai_items', used: 41 },
      { metric: 'premium_identifications', used: 3, limit: 10 },
    ]);

    const other = await api.call('getUsage', { token: await api.signIn(OTHER) });
    expect(other.status).toBe(200);
    expect(other.body.quotas).toEqual([
      { metric: 'ai_items', used: 0 },
      { metric: 'premium_identifications', used: 0 },
    ]);
  });

  it('needs a signed-in user', async () => {
    const response = await api.call('getUsage', {});
    expect(response.status).toBe(401);
  });
});
