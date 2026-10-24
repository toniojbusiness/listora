import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInventoryItem, type Db } from '@listora/db';

import {
  insertAccount,
  insertEvent,
  migratedDatabase,
  type TestDatabase,
} from './db-test-support.ts';
import { accountSpend, costPerItem, spendBreakdown, topAccountsBySpend } from './reports.ts';
import { PostgresUsageStore } from './usage-store.ts';

const OCTOBER = { kind: 'month', month: '2026-10' } as const;
const MISSING_ACCOUNT = '00000000-0000-7000-8000-00000000dead';

let database: TestDatabase;
let db: Db;
let alpha: string;
let bravo: string;
let charlie: string;
let alphaItem: string;
let alphaOtherItem: string;
let bravoItem: string;

/**
 * October 2026: Alpha spends $0.0055 on two items over three calls (one failed, one Premium),
 * Bravo $0.0104 on one item plus a call with no item. Charlie spends only in November, and
 * Alpha also at the last instant of September, so the month edges are tested.
 */
beforeAll(async () => {
  database = await migratedDatabase('ai_reports');
  db = database.db;
  alpha = await insertAccount(db, 'Alpha', 'AL');
  bravo = await insertAccount(db, 'Bravo', 'BR');
  charlie = await insertAccount(db, 'Charlie', 'CH');
  alphaItem = (await createInventoryItem(db, alpha)).id;
  alphaOtherItem = (await createInventoryItem(db, alpha)).id;
  bravoItem = (await createInventoryItem(db, bravo)).id;

  await insertEvent(db, { accountId: alpha, costMicros: 1_000, at: '2026-09-30T23:59:59.999Z' });
  await insertEvent(db, {
    accountId: alpha,
    costMicros: 2_000,
    itemId: alphaItem,
    at: '2026-10-01T00:00:00Z',
  });
  await insertEvent(db, {
    accountId: alpha,
    costMicros: 3_000,
    itemId: alphaItem,
    tier: 'premium',
    model: 'claude-sonnet-5-5',
    at: '2026-10-01T12:00:00Z',
  });
  await insertEvent(db, {
    accountId: alpha,
    costMicros: 500,
    itemId: alphaOtherItem,
    failed: true,
    at: '2026-10-02T08:00:00Z',
  });
  await insertEvent(db, {
    accountId: bravo,
    costMicros: 10_000,
    itemId: bravoItem,
    at: '2026-10-01T05:00:00Z',
  });
  await insertEvent(db, {
    accountId: bravo,
    costMicros: 400,
    purpose: 'category_mapping',
    at: '2026-10-15T09:00:00Z',
  });
  await insertEvent(db, { accountId: charlie, costMicros: 7, at: '2026-11-01T00:00:00Z' });
});

afterAll(async () => {
  await database.close();
});

describe('topAccountsBySpend (real Postgres)', () => {
  it('ranks the month by spend and totals every account, from the daily rollups', async () => {
    expect(await topAccountsBySpend(db, OCTOBER, 20)).toEqual({
      period: OCTOBER,
      total: { costMicros: 15_900, calls: 5, failedCalls: 1, accounts: 2 },
      accounts: [
        { accountId: bravo, accountName: 'Bravo', costMicros: 10_400, calls: 2, failedCalls: 0 },
        { accountId: alpha, accountName: 'Alpha', costMicros: 5_500, calls: 3, failedCalls: 1 },
      ],
    });
  });

  it('lists only the top accounts but still totals all of them', async () => {
    const report = await topAccountsBySpend(db, OCTOBER, 1);
    expect(report.accounts.map((row) => row.accountName)).toEqual(['Bravo']);
    expect(report.total).toEqual({ costMicros: 15_900, calls: 5, failedCalls: 1, accounts: 2 });
  });

  it('reports a single UTC day', async () => {
    const report = await topAccountsBySpend(db, { kind: 'day', day: '2026-10-01' }, 20);
    expect(report.total).toEqual({ costMicros: 15_000, calls: 3, failedCalls: 0, accounts: 2 });
    expect(report.accounts.map((row) => [row.accountName, row.costMicros])).toEqual([
      ['Bravo', 10_000],
      ['Alpha', 5_000],
    ]);
    const september = await topAccountsBySpend(db, { kind: 'day', day: '2026-09-30' }, 20);
    expect(september.accounts).toEqual([
      { accountId: alpha, accountName: 'Alpha', costMicros: 1_000, calls: 1, failedCalls: 0 },
    ]);
  });

  it('reports an empty period as zero', async () => {
    expect(await topAccountsBySpend(db, { kind: 'month', month: '2025-01' }, 5)).toEqual({
      period: { kind: 'month', month: '2025-01' },
      total: { costMicros: 0, calls: 0, failedCalls: 0, accounts: 0 },
      accounts: [],
    });
  });

  it('rejects a limit that is not a positive integer', async () => {
    await expect(topAccountsBySpend(db, OCTOBER, 0)).rejects.toThrow(RangeError);
  });
});

describe('accountSpend (real Postgres)', () => {
  it("reports a month with the usage store's monthly totals", async () => {
    const report = await accountSpend(db, alpha, OCTOBER);
    expect(report).toEqual({
      accountId: alpha,
      accountName: 'Alpha',
      period: OCTOBER,
      totals: await new PostgresUsageStore(db).monthlyUsage(alpha, '2026-10'),
    });
    expect(report?.totals).toMatchObject({
      costMicros: 5_500,
      calls: 3,
      failedCalls: 1,
      inputTokens: 3 * 6_800,
      outputTokens: 3 * 1_500,
      images: 12,
    });
  });

  it("reports a day from the account's daily rollup, and zero for a day without usage", async () => {
    expect((await accountSpend(db, alpha, { kind: 'day', day: '2026-10-02' }))?.totals).toEqual({
      costMicros: 500,
      calls: 1,
      failedCalls: 1,
      inputTokens: 6_800,
      outputTokens: 1_500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 4,
      webSearches: 0,
    });
    expect(
      (await accountSpend(db, charlie, { kind: 'day', day: '2026-10-02' }))?.totals,
    ).toMatchObject({ costMicros: 0, calls: 0 });
  });

  it('is undefined for an account that does not exist', async () => {
    expect(await accountSpend(db, MISSING_ACCOUNT, OCTOBER)).toBeUndefined();
  });
});

describe('costPerItem (real Postgres)', () => {
  it("sums each item's calls, failures and escalations included", async () => {
    expect(await costPerItem(db, OCTOBER)).toEqual({
      period: OCTOBER,
      accountId: null,
      items: 3,
      itemCostMicros: 15_500,
      averageItemCostMicros: 5_167,
      maxItemCostMicros: 10_000,
      unattributedCalls: 1,
      unattributedCostMicros: 400,
    });
  });

  it('reports one account', async () => {
    expect(await costPerItem(db, OCTOBER, { accountId: alpha })).toMatchObject({
      accountId: alpha,
      items: 2,
      itemCostMicros: 5_500,
      averageItemCostMicros: 2_750,
      maxItemCostMicros: 5_000,
      unattributedCalls: 0,
      unattributedCostMicros: 0,
    });
  });

  it('has no average when no item had a call', async () => {
    expect(await costPerItem(db, { kind: 'day', day: '2026-09-30' })).toMatchObject({
      items: 0,
      itemCostMicros: 0,
      averageItemCostMicros: null,
      maxItemCostMicros: 0,
      unattributedCalls: 1,
      unattributedCostMicros: 1_000,
    });
  });
});

describe('spendBreakdown (real Postgres)', () => {
  it('groups spend by purpose, tier, and model, highest cost first', async () => {
    expect(await spendBreakdown(db, OCTOBER)).toEqual([
      {
        purpose: 'item_analysis',
        tier: 'standard',
        model: 'claude-haiku-5-5',
        calls: 3,
        failedCalls: 1,
        costMicros: 12_500,
        inputTokens: 3 * 6_800,
        outputTokens: 3 * 1_500,
      },
      {
        purpose: 'item_analysis',
        tier: 'premium',
        model: 'claude-sonnet-5-5',
        calls: 1,
        failedCalls: 0,
        costMicros: 3_000,
        inputTokens: 6_800,
        outputTokens: 1_500,
      },
      {
        purpose: 'category_mapping',
        tier: 'standard',
        model: 'claude-haiku-5-5',
        calls: 1,
        failedCalls: 0,
        costMicros: 400,
        inputTokens: 6_800,
        outputTokens: 1_500,
      },
    ]);
  });

  it('reports one account and one day', async () => {
    expect(
      await spendBreakdown(db, { kind: 'day', day: '2026-10-01' }, { accountId: alpha }),
    ).toMatchObject([
      { tier: 'premium', calls: 1, costMicros: 3_000 },
      { tier: 'standard', calls: 1, costMicros: 2_000 },
    ]);
    expect(
      await spendBreakdown(db, { kind: 'month', month: '2026-11' }, { accountId: alpha }),
    ).toEqual([]);
  });
});
