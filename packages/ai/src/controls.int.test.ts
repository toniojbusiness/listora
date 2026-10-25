import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@listora/db';

import { AiClient } from './client.ts';
import { AiControlError, PostgresAiControls } from './controls.ts';
import { insertAccount, migratedDatabase, type TestDatabase } from './db-test-support.ts';
import { AiGuardError } from './errors.ts';
import { FakeAiProvider, inMemoryFixtures } from './fake-provider.ts';
import { anyKillSwitch, staticKillSwitch } from './guards.ts';
import { createModelRegistry } from './models.ts';
import { photoSetHashOfImages } from './photo-set-hash.ts';
import { CURRENT_PRICE_TABLE } from './prices.ts';
import { COLOR_OUTPUT, image } from './test-support.ts';
import { PostgresUsageStore } from './usage-store.ts';

const OPERATOR = { actor: 'ops-alice', reason: 'runaway spend investigation' };
const MISSING_ACCOUNT = '00000000-0000-7000-8000-00000000dead';

let database: TestDatabase;
let db: Db;
let controls: PostgresAiControls;
let accountId: string;

beforeAll(async () => {
  database = await migratedDatabase('ai_controls');
  db = database.db;
  controls = new PostgresAiControls(db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  // Each test starts with the switch off and no blocks; the audit trail is append-only, so
  // tests read only the rows they wrote.
  if (await controls.isEngaged()) await controls.setKillSwitch(false, OPERATOR);
  for (const block of await controls.blockedAccounts()) {
    await controls.unblockAccount(block.accountId, OPERATOR);
  }
  accountId = await insertAccount(db, 'Controls test account');
});

async function auditSince(since: Date) {
  return db
    .selectFrom('ai_control_audit')
    .select(['action', 'account_id', 'actor', 'reason'])
    .where('created_at', '>=', since)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

async function now(): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db);
  return rows[0]?.now ?? new Date(0);
}

describe('PostgresAiControls kill switch (real Postgres)', () => {
  it('turns on and off, recording who and why in the audit trail with each change', async () => {
    const since = await now();
    expect(await controls.killSwitch()).toMatchObject({ engaged: false });

    expect(await controls.setKillSwitch(true, OPERATOR)).toEqual({ changed: true });
    expect(await controls.isEngaged()).toBe(true);
    const state = await controls.killSwitch();
    expect(state).toMatchObject({
      engaged: true,
      lastChange: { actor: 'ops-alice', reason: 'runaway spend investigation' },
    });
    expect(state.lastChange?.at).toBeInstanceOf(Date);

    expect(
      await controls.setKillSwitch(false, { actor: 'ops-bob', reason: 'provider recovered' }),
    ).toEqual({ changed: true });
    expect(await controls.isEngaged()).toBe(false);

    expect(await auditSince(since)).toEqual([
      {
        action: 'kill_switch_on',
        account_id: null,
        actor: 'ops-alice',
        reason: 'runaway spend investigation',
      },
      {
        action: 'kill_switch_off',
        account_id: null,
        actor: 'ops-bob',
        reason: 'provider recovered',
      },
    ]);
  });

  it('records nothing when the switch is already in the requested state', async () => {
    const since = await now();
    expect(await controls.setKillSwitch(false, OPERATOR)).toEqual({ changed: false });
    await controls.setKillSwitch(true, OPERATOR);
    expect(await controls.setKillSwitch(true, OPERATOR)).toEqual({ changed: false });
    expect((await auditSince(since)).map((row) => row.action)).toEqual(['kill_switch_on']);
  });

  it('audits concurrent requests to turn it on exactly once', async () => {
    const since = await now();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        controls.setKillSwitch(true, { actor: `ops-${String(index)}`, reason: 'incident' }),
      ),
    );
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await auditSince(since)).toHaveLength(1);
  });

  it('refuses a change without an actor or a reason and changes nothing', async () => {
    const since = await now();
    await expect(controls.setKillSwitch(true, { actor: ' ', reason: 'x' })).rejects.toThrow(
      new AiControlError('actor must be 1 to 200 characters'),
    );
    await expect(controls.setKillSwitch(true, { actor: 'ops', reason: '' })).rejects.toThrow(
      new AiControlError('reason must be 1 to 500 characters'),
    );
    await expect(
      controls.setKillSwitch(true, { actor: 'ops', reason: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(AiControlError);
    expect(await controls.isEngaged()).toBe(false);
    expect(await auditSince(since)).toEqual([]);
  });

  it('stores trimmed actor and reason', async () => {
    const since = await now();
    await controls.setKillSwitch(true, { actor: '  ops-carol ', reason: ' spike \n' });
    expect(await auditSince(since)).toEqual([
      expect.objectContaining({ actor: 'ops-carol', reason: 'spike' }),
    ]);
  });
});

describe('PostgresAiControls account blocks (real Postgres)', () => {
  it('blocks and unblocks an account, auditing each change', async () => {
    const other = await insertAccount(db, 'Unblocked account', 'UB');
    const since = await now();

    expect(await controls.blockAccount(accountId, OPERATOR)).toEqual({ changed: true });
    expect(await controls.isBlocked(accountId)).toBe(true);
    expect(await controls.isBlocked(other)).toBe(false);
    expect(await controls.blockedAccounts()).toEqual([
      {
        accountId,
        accountName: 'Controls test account',
        blockedBy: 'ops-alice',
        reason: 'runaway spend investigation',
        blockedAt: expect.any(Date) as Date,
      },
    ]);

    expect(await controls.blockAccount(accountId, OPERATOR)).toEqual({ changed: false });
    expect(
      await controls.unblockAccount(accountId, { actor: 'ops-bob', reason: 'false alarm' }),
    ).toEqual({ changed: true });
    expect(await controls.unblockAccount(accountId, OPERATOR)).toEqual({ changed: false });
    expect(await controls.isBlocked(accountId)).toBe(false);

    expect(await auditSince(since)).toEqual([
      {
        action: 'account_block_on',
        account_id: accountId,
        actor: 'ops-alice',
        reason: 'runaway spend investigation',
      },
      {
        action: 'account_block_off',
        account_id: accountId,
        actor: 'ops-bob',
        reason: 'false alarm',
      },
    ]);
    expect(await controls.auditTrail({ accountId })).toMatchObject([
      { action: 'account_block_off', accountId, actor: 'ops-bob' },
      { action: 'account_block_on', accountId, actor: 'ops-alice' },
    ]);
  });

  it('refuses to block or unblock an account that does not exist', async () => {
    const since = await now();
    await expect(controls.blockAccount(MISSING_ACCOUNT, OPERATOR)).rejects.toThrow(
      new AiControlError(`no account ${MISSING_ACCOUNT}`),
    );
    await expect(controls.unblockAccount(MISSING_ACCOUNT, OPERATOR)).rejects.toThrow(
      new AiControlError(`no account ${MISSING_ACCOUNT}`),
    );
    expect(await auditSince(since)).toEqual([]);
  });

  it('lists the audit trail newest first, limited', async () => {
    await controls.setKillSwitch(true, OPERATOR);
    await controls.blockAccount(accountId, OPERATOR);
    await controls.setKillSwitch(false, OPERATOR);
    const latest = await controls.auditTrail({ limit: 2 });
    expect(latest.map((entry) => entry.action)).toEqual(['kill_switch_off', 'account_block_on']);
  });

  it('deletes an account with its blocks and their audit rows, keeping kill switch history', async () => {
    const doomed = await insertAccount(db, 'Deleted account', 'DL');
    await controls.blockAccount(doomed, OPERATOR);
    await controls.setKillSwitch(true, OPERATOR);
    const before = await db
      .selectFrom('ai_control_audit')
      .select(sql<number>`count(*)`.as('count'))
      .where('account_id', 'is', null)
      .executeTakeFirstOrThrow();

    await db.deleteFrom('account').where('id', '=', doomed).execute();

    expect(await controls.isBlocked(doomed)).toBe(false);
    expect(await controls.auditTrail({ accountId: doomed })).toEqual([]);
    const after = await db
      .selectFrom('ai_control_audit')
      .select(sql<number>`count(*)`.as('count'))
      .where('account_id', 'is', null)
      .executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
  });
});

describe('AI control schema (real Postgres)', () => {
  it('keeps the audit trail append-only', async () => {
    await controls.setKillSwitch(true, OPERATOR);
    const [entry] = await controls.auditTrail({ limit: 1 });
    await expect(
      sql`update ai_control_audit set reason = 'edited' where id = ${entry?.id}`.execute(db),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      db
        .deleteFrom('ai_control_audit')
        .where('id', '=', entry?.id ?? '')
        .execute(),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('holds exactly one kill switch row', async () => {
    await expect(sql`insert into ai_kill_switch default values`.execute(db)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      sql`insert into ai_kill_switch (singleton) values (false)`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ties account audit rows to an account and kill switch rows to none', async () => {
    await expect(
      sql`insert into ai_control_audit (action, actor, reason)
          values ('account_block_on', 'ops', 'x')`.execute(db),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ai_control_audit_account_matches_action',
    });
    await expect(
      sql`insert into ai_control_audit (action, account_id, actor, reason)
          values ('kill_switch_on', ${accountId}, 'ops', 'x')`.execute(db),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ai_control_audit_account_matches_action',
    });
  });
});

describe('AiClient with the Postgres controls (real Postgres)', () => {
  const photos = [image('front')];
  const fixtures = inMemoryFixtures({
    [photoSetHashOfImages(photos)]: {
      outputs: { dominant_color: { color: 'navy', confidence: 0.9 } },
      usage: { inputTokens: 6_800, outputTokens: 1_500 },
    },
  });

  function client(): AiClient {
    return new AiClient({
      provider: new FakeAiProvider({ fixtures }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: new PostgresUsageStore(db),
      killSwitch: anyKillSwitch(staticKillSwitch(false), controls),
      accountBlocks: controls,
      dailyBudgetMicros: 1_000_000,
    });
  }

  const call = (account: string) =>
    client().generate({
      context: { accountId: account, purpose: 'item_analysis' },
      tier: 'standard',
      system: 'Name the dominant color.',
      prompt: 'Answer in JSON.',
      photoSetHash: photoSetHashOfImages(photos),
      images: photos,
      output: COLOR_OUTPUT,
    });

  async function events(account: string): Promise<number> {
    const row = await db
      .selectFrom('ai_usage_event')
      .select(sql<number>`count(*)`.as('count'))
      .where('account_id', '=', account)
      .executeTakeFirstOrThrow();
    return row.count;
  }

  it('refuses every account while the kill switch is on, and resumes when it is off', async () => {
    await call(accountId);
    await controls.setKillSwitch(true, OPERATOR);
    await expect(call(accountId)).rejects.toMatchObject({ reason: { kind: 'kill_switch' } });
    expect(await events(accountId)).toBe(1);
    await controls.setKillSwitch(false, OPERATOR);
    await call(accountId);
    expect(await events(accountId)).toBe(2);
  });

  it('refuses a blocked account only, recording nothing for it', async () => {
    const other = await insertAccount(db, 'Neighbour', 'NB');
    await controls.blockAccount(accountId, OPERATOR);
    const error = await call(accountId).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiGuardError);
    expect((error as AiGuardError).reason).toEqual({ kind: 'account_blocked' });
    await call(other);
    expect(await events(accountId)).toBe(0);
    expect(await events(other)).toBe(1);

    await controls.unblockAccount(accountId, OPERATOR);
    await call(accountId);
    expect(await events(accountId)).toBe(1);
  });
});
