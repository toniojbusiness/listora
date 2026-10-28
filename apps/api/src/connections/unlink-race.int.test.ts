/**
 * Unlinking while work on the connection is in flight, on real Postgres
 * (docs/features/privacy.md#unlinking-while-work-runs): the seller unlinks Depop while their
 * phone is answering the connection's sale check. One of them used to fail now and then with
 * Postgres's "deadlock detected" (GitHub's iPhone check on PR #134): the answer held the run's
 * rows and then needed the connection, while the unlink held the connection and waited for those
 * rows. Now the answer takes the connection first, so the unlink waits for it and both finish.
 * Work that still breaks that order makes the unlink the deadlock's victim, and it runs again.
 *
 * The order is made certain, not left to timing: a second session holds the sale check's run
 * row, so the answer stops right after it has written the phone's run, and the unlink starts
 * then.
 */
import { randomUUID } from 'node:crypto';

import { PHONE_RUNTIME_VERSION } from '@listora/automation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

const SELLER = 'unlink-race-seller@example.com';

describe('unlinking while work on the connection runs (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let accountId: string;
  const installationId = randomUUID();

  beforeAll(async () => {
    api = await createTestApi('unlink_race');
    token = await api.signIn(SELLER);
    accountId = (await api.tenantOf(SELLER)).accountId;
  });

  afterAll(async () => {
    await api.close();
  });

  const claim = () =>
    api.call('claimPhoneRun', {
      token,
      body: { installationId, runtimeVersion: PHONE_RUNTIME_VERSION },
    });
  const answer = (runId: string, value: unknown) =>
    api.call('answerPhoneCall', {
      token,
      params: { runId, index: '0' },
      body: {
        installationId,
        answer: { type: 'ran', result: { ok: true, mutated: false, value, steps: ['read'] } },
      },
    });

  /** Links the seller's Depop on their phone; returns the connection. */
  async function link(): Promise<string> {
    await api.call('registerDevice', {
      token,
      params: { installationId },
      body: { name: "Sam's iPhone", platform: 'ios', runtimeVersion: PHONE_RUNTIME_VERSION },
    });
    const linked = await api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'depop' },
      body: {
        installationId,
        cookies: [
          {
            name: 'access_token',
            value: 'depop-session-secret',
            domain: '.depop.com',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
          },
        ],
      },
    });
    expect(linked.status).toBe(201);
    const { id } = await api.db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    return id;
  }

  /** Waits until `count` sessions of the test's database wait for a lock. */
  async function lockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(api.db);
      if ((rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline)
        throw new Error(`fewer than ${String(count)} sessions wait for a lock`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("unlinks Depop while the phone answers the connection's sale check, and both finish", async () => {
    await link();
    // The phone passes the session check, then claims the sale check.
    const check = (await claim()).body.run;
    expect(check).toMatchObject({ purpose: 'session_check' });
    expect((await answer(check?.id ?? '', undefined)).status).toBe(200);
    const saleCheck = (await claim()).body.run;
    expect(saleCheck).toMatchObject({ purpose: 'sale_check', call: { index: 0 } });
    const { id: saleCheckRunId } = await api.db
      .selectFrom('sale_check_run')
      .select('id')
      .where('account_id', '=', accountId)
      .where('finished_at', 'is', null)
      .executeTakeFirstOrThrow();

    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const blocker = api.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('sale_check_run')
        .select('id')
        .where('id', '=', saleCheckRunId)
        .forUpdate()
        .execute();
      held();
      await released;
    });
    await holding;

    // The phone answers: no sales. The answer records the phone's run, then waits for the
    // sale check's run row.
    const answered = answer(saleCheck?.id ?? '', []);
    await lockWaiters(1);
    // The seller unlinks Depop meanwhile.
    const unlinked = api.call('disconnectConnection', {
      token,
      params: { marketplace: 'depop' },
    });
    await lockWaiters(2);
    release();
    await blocker;

    const [answerResult, unlinkResult] = await Promise.all([answered, unlinked]);
    expect(unlinkResult.status).toBe(200);
    expect(unlinkResult.body).toMatchObject({ marketplace: 'depop', status: 'not_connected' });
    // The answer came first, so it was recorded before the connection's data was deleted.
    expect(answerResult.status).toBe(200);
    expect(
      await api.db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('account_id', '=', accountId)
        .execute(),
    ).toEqual([]);
    expect(
      await api.db
        .selectFrom('phone_work')
        .select('id')
        .where('account_id', '=', accountId)
        .execute(),
    ).toEqual([]);
  });

  it('unlinks even next to work that takes the connection last: the deadlock it meets runs it again', async () => {
    const connectionId = await link();
    // A run on the connection, from before.
    await api.db
      .insertInto('automation_run')
      .values({
        account_id: accountId,
        connection_id: connectionId,
        marketplace: 'depop',
        purpose: 'sale_check',
        script: 'sold orders',
      })
      .execute();
    // Work out of the lock order: it writes the connection's run, then a row that references the
    // connection, without locking the connection first.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const work = api.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('automation_run')
        .set({ finished_at: sql<Date>`now()`, outcome: 'succeeded' })
        .where('connection_id', '=', connectionId)
        .execute();
      held();
      await released;
      await trx
        .insertInto('background_read_health')
        .values({
          account_id: accountId,
          connection_id: connectionId,
          marketplace: 'depop',
          read: 'sale_check',
          last_succeeded_at: sql<Date>`now()`,
        })
        .execute();
    });
    await holding;
    const unlinked = api.call('disconnectConnection', { token, params: { marketplace: 'depop' } });
    // The unlink waits for the work's run, and then the work for the connection.
    await lockWaiters(1);
    release();
    const [settled, unlinkResult] = await Promise.all([work.then(() => 'ok', String), unlinked]);
    expect(unlinkResult.status).toBe(200);
    expect(settled).toBe('ok');
    expect(api.logLines).toContainEqual(
      expect.objectContaining({ msg: 'unlink deadlocked with work on the connection; again' }),
    );
    expect(
      await api.db
        .selectFrom('marketplace_connection')
        .select('id')
        .where('account_id', '=', accountId)
        .execute(),
    ).toEqual([]);
  });
});
