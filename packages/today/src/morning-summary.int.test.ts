import { sql } from 'kysely';

import { PUSH_TASK } from '@listora/push';
import { createLogger } from '@listora/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMorningSummaries, TODAY_SUMMARY_WINDOW_MINUTES } from './morning-summary.ts';
import { loadSummarySettings, saveSummarySettings } from './settings.ts';
import { createTodayHarness, type TodayHarness } from './test-support.ts';

const logger = createLogger({ service: 'today-test', level: 'silent' });
const MINUTE = 60_000;

describe('the morning summary (real Postgres)', () => {
  let harness: TodayHarness;

  beforeAll(async () => {
    harness = await createTodayHarness('today_morning');
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Each test owns the settings and the push queue.
    await harness.db.deleteFrom('today_summary_setting').execute();
    await sql`delete from graphile_worker._private_jobs`.execute(harness.db);
  });

  /** An account with two drafts, so its summary has something to say. */
  async function busyAccount(settings: { localTime: string; timeZone: string; enabled?: boolean }) {
    const accountId = await harness.account();
    await harness.item(accountId, { status: 'draft' });
    await harness.item(accountId, { status: 'draft' });
    await saveSummarySettings(harness.db, accountId, { enabled: true, ...settings });
    return accountId;
  }

  const run = (now: Date) => runMorningSummaries({ db: harness.db, logger, now: () => now });

  it("sends once at the chosen time in the account's time zone, never twice a day", async () => {
    // 08:00 in New York on 2026-10-25 (EDT, UTC-4) is 12:00 UTC.
    const accountId = await busyAccount({ localTime: '08:00', timeZone: 'America/New_York' });

    expect(await run(new Date('2026-10-25T11:59:00Z'))).toEqual({ claimed: 0, sent: 0 });
    expect(await run(new Date('2026-10-25T12:00:00Z'))).toEqual({ claimed: 1, sent: 1 });
    expect(await run(new Date('2026-10-25T12:05:00Z'))).toEqual({ claimed: 0, sent: 0 });

    const jobs = await harness.jobs(PUSH_TASK);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.key).toBe(`push:today_summary:${accountId}:2026-10-25`);
    expect(jobs[0]?.payload).toEqual({
      accountId,
      category: 'today_summary',
      title: 'Your day on Listora',
      body: 'Review 2 drafts.',
      urgency: 'normal',
      threadId: 'today',
      data: { screen: 'today' },
    });

    // The next local day sends again.
    expect(await run(new Date('2026-10-26T12:10:00Z'))).toEqual({ claimed: 1, sent: 1 });
  });

  it('sends a late summary within its window, and skips a day the window passed', async () => {
    await busyAccount({ localTime: '07:30', timeZone: 'UTC' });
    const due = new Date('2026-10-25T07:30:00Z').getTime();
    expect(await run(new Date(due + (TODAY_SUMMARY_WINDOW_MINUTES - 1) * MINUTE))).toEqual({
      claimed: 1,
      sent: 1,
    });

    await harness.db.deleteFrom('today_summary_setting').execute();
    await busyAccount({ localTime: '07:30', timeZone: 'UTC' });
    expect(await run(new Date(due + TODAY_SUMMARY_WINDOW_MINUTES * MINUTE))).toEqual({
      claimed: 0,
      sent: 0,
    });
  });

  it('sends nothing when turned off, without a time zone, or with nothing to do', async () => {
    await busyAccount({ localTime: '09:00', timeZone: 'UTC', enabled: false });
    const noZone = await harness.account();
    await harness.item(noZone, { status: 'draft' });
    await harness.db
      .insertInto('today_summary_setting')
      .values({ account_id: noZone, local_time: '09:00' })
      .execute();
    const caughtUp = await harness.account();
    await saveSummarySettings(harness.db, caughtUp, {
      enabled: true,
      localTime: '09:00',
      timeZone: 'UTC',
    });

    // The caught-up account's day is claimed, but it gets no notification.
    expect(await run(new Date('2026-10-25T09:00:00Z'))).toEqual({ claimed: 1, sent: 0 });
    expect(await harness.jobs(PUSH_TASK)).toEqual([]);
  });

  it('works through every due account in batches', async () => {
    const accounts = await Promise.all(
      [0, 1, 2, 3, 4].map(() => busyAccount({ localTime: '06:00', timeZone: 'Europe/Paris' })),
    );
    // 06:00 in Paris on 2026-10-26 (CET, UTC+1) is 05:00 UTC.
    const result = await runMorningSummaries({
      db: harness.db,
      logger,
      now: () => new Date('2026-10-26T05:00:00Z'),
      batchSize: 2,
    });
    expect(result).toEqual({ claimed: 5, sent: 5 });
    const keys = (await harness.jobs(PUSH_TASK)).map((job) => job.key).sort();
    expect(keys).toEqual(accounts.map((id) => `push:today_summary:${id}:2026-10-26`).sort());
  });
});

describe('the morning summary setting (real Postgres)', () => {
  let harness: TodayHarness;

  beforeAll(async () => {
    harness = await createTodayHarness('today_settings');
  });

  afterAll(async () => {
    await harness.close();
  });

  it('defaults to on at 08:00 with no time zone, and saves a change', async () => {
    const accountId = await harness.account();
    expect(await loadSummarySettings(harness.db, accountId)).toEqual({
      enabled: true,
      localTime: '08:00',
      timeZone: null,
    });
    const saved = { enabled: false, localTime: '06:45', timeZone: 'America/Los_Angeles' };
    expect(await saveSummarySettings(harness.db, accountId, saved)).toEqual(saved);
    expect(await loadSummarySettings(harness.db, accountId)).toEqual(saved);
  });

  it('refuses a time zone Postgres does not know, and a malformed time', async () => {
    const accountId = await harness.account();
    await expect(
      saveSummarySettings(harness.db, accountId, {
        enabled: true,
        localTime: '08:00',
        timeZone: 'Mars/Olympus',
      }),
    ).rejects.toMatchObject({ field: 'timeZone' });
    await expect(
      saveSummarySettings(harness.db, accountId, {
        enabled: true,
        localTime: '8:00',
        timeZone: 'UTC',
      }),
    ).rejects.toMatchObject({ field: 'localTime' });
    expect((await loadSummarySettings(harness.db, accountId)).timeZone).toBeNull();
  });
});
