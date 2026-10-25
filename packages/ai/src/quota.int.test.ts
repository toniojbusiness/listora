import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, SchemaMigrator, type Db } from '@listora/db';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import type { QuotaContext } from './guards.ts';
import { PostgresQuotaPolicy, utcMonthPeriod } from './quota.ts';

let scratch: ScratchDatabase;
let db: Db;
let accountId: string;

beforeAll(async () => {
  scratch = await createScratchDatabase('ai_quota');
  db = createDatabase({ connectionString: scratch.url, max: 5 });
  await new SchemaMigrator(db).migrateToLatest();
});

afterAll(async () => {
  await db.destroy();
  await scratch.drop();
});

beforeEach(async () => {
  ({ id: accountId } = await db
    .insertInto('account')
    .values({ name: 'Quota test account', sku_prefix: 'QT' })
    .returning('id')
    .executeTakeFirstOrThrow());
});

function premium(units = 1): QuotaContext {
  return {
    accountId,
    tier: 'premium',
    purpose: 'item_analysis',
    charge: { metric: 'premium_identifications', units },
  };
}

async function setQuota(quota: number, periodStart = '2026-10-01'): Promise<void> {
  await db
    .updateTable('usage_counter')
    .set({ quota })
    .where('account_id', '=', accountId)
    .where('metric', '=', 'premium_identifications')
    .where('period_start', '=', periodStart)
    .execute();
}

describe('utcMonthPeriod', () => {
  it('is the UTC calendar month, across a year end', () => {
    expect(utcMonthPeriod(new Date('2026-10-24T23:59:59-07:00'))).toEqual({
      start: '2026-10-01',
      end: '2026-11-01',
    });
    expect(utcMonthPeriod(new Date('2026-12-31T12:00:00Z'))).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
  });
});

describe('PostgresQuotaPolicy (real Postgres)', () => {
  let now = new Date('2026-10-24T12:00:00Z');
  const policy = () => new PostgresQuotaPolicy(db, { now: () => now });

  beforeEach(() => {
    now = new Date('2026-10-24T12:00:00Z');
  });

  it('counts used units per account, metric, and month', async () => {
    await policy().consume(premium());
    await policy().consume(premium(2));
    await policy().consume({ ...premium(), charge: { metric: 'ai_items', units: 1 } });
    expect(await policy().used(accountId, 'premium_identifications')).toBe(3);
    expect(await policy().used(accountId, 'ai_items')).toBe(1);
    const rows = await db
      .selectFrom('usage_counter')
      .select(['metric', 'period_start', 'period_end', 'used', 'quota'])
      .where('account_id', '=', accountId)
      .orderBy('metric')
      .execute();
    expect(rows).toEqual([
      {
        metric: 'ai_items',
        period_start: '2026-10-01',
        period_end: '2026-11-01',
        used: 1,
        quota: null,
      },
      {
        metric: 'premium_identifications',
        period_start: '2026-10-01',
        period_end: '2026-11-01',
        used: 3,
        quota: null,
      },
    ]);

    now = new Date('2026-11-01T00:00:00Z');
    expect(await policy().used(accountId, 'premium_identifications')).toBe(0);
  });

  it('allows everything until a quota is set, then refuses what would exceed it', async () => {
    expect(await policy().check(premium())).toEqual({ allowed: true });
    await policy().consume(premium());
    expect(await policy().check(premium(100))).toEqual({ allowed: true });

    await setQuota(2);
    expect(await policy().check(premium())).toEqual({ allowed: true });
    expect(await policy().check(premium(2))).toEqual({ allowed: false, used: 1, limit: 2 });
    await policy().consume(premium());
    expect(await policy().check(premium())).toEqual({ allowed: false, used: 2, limit: 2 });

    // A new period starts from zero.
    now = new Date('2026-11-02T00:00:00Z');
    expect(await policy().check(premium())).toEqual({ allowed: true });
  });

  it('never loses a unit when calls finish at the same time', async () => {
    await Promise.all(Array.from({ length: 20 }, () => policy().consume(premium())));
    expect(await policy().used(accountId, 'premium_identifications')).toBe(20);
  });

  it('reports every quota of the current period, unused and unlimited ones included', async () => {
    const period = { start: '2026-10-01', end: '2026-11-01' };
    expect(await policy().usage(accountId)).toEqual({
      period,
      quotas: [
        { metric: 'ai_items', used: 0, limit: null },
        { metric: 'premium_identifications', used: 0, limit: null },
      ],
    });

    await policy().consume(premium(2));
    await setQuota(5);
    // Another period's counts do not show.
    await policy().consume({ ...premium(), charge: { metric: 'ai_items', units: 1 } });
    now = new Date('2026-09-15T00:00:00Z');
    await policy().consume({ ...premium(), charge: { metric: 'ai_items', units: 7 } });
    now = new Date('2026-10-24T12:00:00Z');

    expect(await policy().usage(accountId)).toEqual({
      period,
      quotas: [
        { metric: 'ai_items', used: 1, limit: null },
        { metric: 'premium_identifications', used: 2, limit: 5 },
      ],
    });
  });
});
