import { Writable } from 'node:stream';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '@listora/db';
import { createLogger } from '@listora/shared';

import { checkAiSpend, type AiAlertThresholds } from './alerts.ts';
import { PostgresAiControls } from './controls.ts';
import {
  insertAccount,
  insertEvent,
  migratedDatabase,
  type TestDatabase,
} from './db-test-support.ts';

const THRESHOLDS: AiAlertThresholds = {
  dailyBudgetMicros: 1_000_000,
  globalDailyAlertMicros: 25_000_000,
  warnPercent: 80,
};

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await migratedDatabase('ai_alerts');
  db = database.db;
});

afterAll(async () => {
  await database.close();
});

/** Each test uses its own UTC day, so the usage of one test never reaches another's check. */
async function spend(day: string, accountId: string, costMicros: number): Promise<void> {
  await insertEvent(db, { accountId, costMicros, at: `${day}T12:00:00Z` });
}

function memoryLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const lines = () =>
    chunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger: createLogger({ service: 'test', level: 'info', destination: stream }), lines };
}

describe('checkAiSpend (real Postgres)', () => {
  it('flags accounts approaching (from the warn percentage) or over their daily budget', async () => {
    const day = '2026-03-01';
    const under = await insertAccount(db, 'Under');
    const approaching = await insertAccount(db, 'Approaching');
    const at = await insertAccount(db, 'At the cap');
    const over = await insertAccount(db, 'Over');
    await spend(day, under, 799_999);
    await spend(day, approaching, 800_000);
    await spend(day, at, 600_000);
    await spend(day, at, 400_000);
    await spend(day, over, 1_200_000);
    // Yesterday's spend does not count today.
    await spend('2026-02-28', under, 5_000_000);

    const check = await checkAiSpend(db, THRESHOLDS, { day });
    expect(check.day).toBe(day);
    expect(check.globalSpentMicros).toBe(3_799_999);
    expect(check.alerts).toEqual([
      {
        kind: 'account_daily_budget',
        severity: 'over',
        accountId: over,
        spentMicros: 1_200_000,
        limitMicros: 1_000_000,
      },
      {
        kind: 'account_daily_budget',
        severity: 'over',
        accountId: at,
        spentMicros: 1_000_000,
        limitMicros: 1_000_000,
      },
      {
        kind: 'account_daily_budget',
        severity: 'approaching',
        accountId: approaching,
        spentMicros: 800_000,
        limitMicros: 1_000_000,
      },
    ]);
  });

  it('flags the global daily spend approaching and over its threshold', async () => {
    const day = '2026-03-02';
    const big = await insertAccount(db, 'Big spender');
    await spend(day, big, 20_000_000);

    const approaching = await checkAiSpend(
      db,
      { ...THRESHOLDS, dailyBudgetMicros: 50_000_000 },
      { day },
    );
    expect(approaching.alerts).toEqual([
      {
        kind: 'global_daily_spend',
        severity: 'approaching',
        spentMicros: 20_000_000,
        thresholdMicros: 25_000_000,
      },
    ]);

    const over = await checkAiSpend(
      db,
      { ...THRESHOLDS, dailyBudgetMicros: 50_000_000, globalDailyAlertMicros: 20_000_000 },
      { day },
    );
    expect(over.alerts).toEqual([
      expect.objectContaining({ kind: 'global_daily_spend', severity: 'over' }),
    ]);

    const quiet = await checkAiSpend(
      db,
      { ...THRESHOLDS, dailyBudgetMicros: 50_000_000, warnPercent: 81 },
      { day },
    );
    expect(quiet.alerts).toEqual([]);
  });

  it('flags AI plan quotas approaching or used up in the current period only', async () => {
    // A period of its own, so these counters never reach the other tests' checks.
    const day = '2025-06-15';
    const quota = async (
      name: string,
      row: { metric: string; used: number; quota: number | null; start?: string; end?: string },
    ) => {
      const accountId = await insertAccount(db, name);
      await db
        .insertInto('usage_counter')
        .values({
          account_id: accountId,
          metric: row.metric,
          used: row.used,
          quota: row.quota,
          period_start: row.start ?? '2025-06-01',
          period_end: row.end ?? '2025-07-01',
        })
        .execute();
      return accountId;
    };
    const near = await quota('Near', { metric: 'ai_items', used: 120, quota: 150 });
    const usedUp = await quota('Used up', {
      metric: 'premium_identifications',
      used: 15,
      quota: 15,
    });
    await quota('Fine', { metric: 'ai_items', used: 119, quota: 150 });
    await quota('Unlimited', { metric: 'ai_items', used: 5_000, quota: null });
    await quota('No premium', { metric: 'premium_identifications', used: 0, quota: 0 });
    await quota('Not AI', { metric: 'active_items', used: 500, quota: 500 });
    await quota('Ended', {
      metric: 'ai_items',
      used: 150,
      quota: 150,
      start: '2025-05-15',
      end: day,
    });
    await quota('Not started', { metric: 'ai_items', used: 150, quota: 150, start: '2025-06-16' });

    const check = await checkAiSpend(db, THRESHOLDS, { day });
    expect(check.alerts).toEqual([
      {
        kind: 'account_quota',
        severity: 'over',
        accountId: usedUp,
        metric: 'premium_identifications',
        used: 15,
        quota: 15,
        periodEnd: '2025-07-01',
      },
      {
        kind: 'account_quota',
        severity: 'approaching',
        accountId: near,
        metric: 'ai_items',
        used: 120,
        quota: 150,
        periodEnd: '2025-07-01',
      },
    ]);
  });

  it('logs one structured line per alert and a summary that alarms can key on', async () => {
    const day = '2026-03-20';
    const over = await insertAccount(db, 'Private Shop Name');
    const approaching = await insertAccount(db, 'Another Shop');
    await spend(day, over, 1_000_000);
    await spend(day, approaching, 900_000);
    const { logger, lines } = memoryLogger();

    await checkAiSpend(db, { ...THRESHOLDS, globalDailyAlertMicros: 1_500_000 }, { day, logger });

    expect(lines()).toEqual([
      expect.objectContaining({
        level: 50,
        event: 'ai_spend_alert',
        alert: 'global_daily_spend',
        severity: 'over',
        day,
        spentMicros: 1_900_000,
        thresholdMicros: 1_500_000,
        msg: 'AI spend across all accounts reached the global daily alert threshold',
      }),
      expect.objectContaining({
        level: 50,
        event: 'ai_spend_alert',
        alert: 'account_daily_budget',
        severity: 'over',
        accountId: over,
        spentMicros: 1_000_000,
        limitMicros: 1_000_000,
        msg: 'account reached its AI daily budget',
      }),
      expect.objectContaining({
        level: 40,
        event: 'ai_spend_alert',
        alert: 'account_daily_budget',
        severity: 'approaching',
        accountId: approaching,
        msg: 'account approaching its AI daily budget',
      }),
      expect.objectContaining({
        level: 30,
        event: 'ai_spend_check',
        day,
        globalSpentMicros: 1_900_000,
        globalDailyAlertMicros: 1_500_000,
        globalDailySpend: 'over',
        accountsOverDailyBudget: 1,
        accountsApproachingDailyBudget: 1,
        quotasOver: 0,
        quotasApproaching: 0,
        killSwitchEngaged: false,
        blockedAccounts: 0,
        msg: 'AI spend check',
      }),
    ]);
    // Alerts identify accounts by id only; names are customer data.
    expect(JSON.stringify(lines())).not.toContain('Shop');
  });

  it('logs only the summary when nothing is near a limit', async () => {
    const { logger, lines } = memoryLogger();
    const check = await checkAiSpend(db, THRESHOLDS, { day: '2026-03-25', logger });
    expect(check.alerts).toEqual([]);
    expect(lines()).toEqual([
      expect.objectContaining({
        event: 'ai_spend_check',
        globalDailySpend: 'ok',
        globalSpentMicros: 0,
      }),
    ]);
  });

  it('reports the current kill switch and number of blocked accounts', async () => {
    const controls = new PostgresAiControls(db);
    const blocked = await insertAccount(db, 'Blocked');
    const change = { actor: 'ops', reason: 'test' };
    await controls.setKillSwitch(true, change);
    await controls.blockAccount(blocked, change);
    try {
      expect(await checkAiSpend(db, THRESHOLDS, { day: '2026-03-26' })).toMatchObject({
        killSwitchEngaged: true,
        blockedAccounts: 1,
      });
    } finally {
      await controls.setKillSwitch(false, change);
      await controls.unblockAccount(blocked, change);
    }
  });

  it('checks today on the database clock by default, the day the budget guard uses', async () => {
    const { rows } = await sql<{ day: string }>`
      select (now() at time zone 'UTC')::date::text as day
    `.execute(db);
    expect((await checkAiSpend(db, THRESHOLDS)).day).toBe(rows[0]?.day);
  });

  it('rejects thresholds that cannot work and a malformed day', async () => {
    await expect(checkAiSpend(db, { ...THRESHOLDS, warnPercent: 0 })).rejects.toThrow(RangeError);
    await expect(checkAiSpend(db, { ...THRESHOLDS, globalDailyAlertMicros: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(checkAiSpend(db, { ...THRESHOLDS, dailyBudgetMicros: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(checkAiSpend(db, THRESHOLDS, { day: '2026-02-30' })).rejects.toThrow(RangeError);
  });
});
