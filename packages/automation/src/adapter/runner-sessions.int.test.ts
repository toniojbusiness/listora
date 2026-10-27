/**
 * Browser sessions in the runner (real Postgres, real headless Chromium, the fake site): the
 * vault's session, the per-seller lock, rate limits and pauses, run records, cookie rotation,
 * and relinking after a check.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import type { ConnectionRef } from '@listora/marketplaces';
import { LocalTokenVault, SessionVault } from '@listora/connections';

import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import type { AutomationProfile } from '../profiles.ts';
import type { Script } from '../runner/types.ts';
import { fakeSiteProfile, silentLogger, testRunner } from '../test-support.ts';
import { RunnerSessions } from './runner-sessions.ts';
import type { SessionRequest } from './sessions.ts';

describe('RunnerSessions (real Postgres, headless Chromium)', () => {
  let database: MigratedDatabase;
  let site: FakeAutomationSite;
  let profile: AutomationProfile;
  let accountId: string;
  let connection: ConnectionRef;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  const { runner, screenshots } = testRunner({ stepTimeoutMs: 3_000 });

  beforeAll(async () => {
    database = await createMigratedDatabase('runner_sessions', { jobQueue: true, max: 8 });
    site = await FakeAutomationSite.start(0, { rotateSessionEvery: 3 });
    profile = fakeSiteProfile(site);
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
    await database.close();
  });

  beforeEach(async () => {
    site.clearFaults();
    accountId = await insertAccount(database.db);
    const linked = await vault.linkSession(database.db, {
      accountId,
      marketplace: 'mercari',
      cookies: [site.issueSession()],
      cookieDomains: profile.cookieDomains,
    });
    connection = { id: linked.connectionId, mode: 'automation', status: 'connected' };
  });

  function sessions(overrides: Partial<AutomationProfile> = {}) {
    return new RunnerSessions({
      db: database.db,
      vault,
      runner,
      profile: (marketplace) =>
        marketplace === 'mercari' ? { ...profile, ...overrides } : undefined,
      logger: silentLogger,
    });
  }

  const request = (script = 'account'): SessionRequest => ({
    connection,
    purpose: 'health',
    operationId: null,
    script,
    scriptSet: { name: 'mercari', marketplace: 'mercari', siteUrl: 'https://www.mercari.com' },
    call: { script: 'health' },
  });

  const account: Script<string | null> = (step) =>
    step('open the account', { mutates: false }, async (page) => {
      await page.goto(`${site.url}/`);
      return page.attribute('[data-account]', 'data-account');
    });

  const runs = () =>
    database.db
      .selectFrom('automation_run')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('started_at')
      .execute();

  const signal = () => new AbortController().signal;

  it("runs a script in the seller's stored session and records the run", async () => {
    const run = await sessions().use(
      request(),
      (session, runSignal) => session.read('account', account, runSignal),
      signal(),
    );
    expect(run).toEqual({
      type: 'ran',
      result: {
        ok: true,
        value: 'fake-seller',
        mutated: false,
        steps: ['open the account'],
        stepMs: [expect.any(Number) as unknown],
      },
    });
    expect(await runs()).toEqual([
      expect.objectContaining({
        connection_id: connection.id,
        marketplace: 'mercari',
        purpose: 'health',
        script: 'account',
        outcome: 'succeeded',
        finished_at: expect.any(Date) as Date,
        challenge_kind: null,
        screenshot_key: null,
      }),
    ]);
  });

  it('stores the cookies the marketplace refreshed, so the next session uses them', async () => {
    const before = await vault.load(database.db, { accountId, connectionId: connection.id });
    const browse: Script<void> = (step) =>
      step('browse', { mutates: false }, async (page) => {
        for (let visit = 0; visit < 3; visit += 1) await page.goto(`${site.url}/`);
      });
    expect(
      await sessions().use(request(), (session, s) => session.read('browse', browse, s), signal()),
    ).toMatchObject({ type: 'ran', result: { ok: true } });
    const after = await vault.load(database.db, { accountId, connectionId: connection.id });
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.cookies[0]?.value).not.toBe(before?.cookies[0]?.value);
    expect(site.sessionValid(before?.cookies[0]?.value ?? '')).toBe(false);
    // The refreshed session still logs in.
    expect(
      await sessions().use(
        request(),
        (session, s) => session.read('account', account, s),
        signal(),
      ),
    ).toMatchObject({ type: 'ran', result: { ok: true, value: 'fake-seller' } });
  });

  it('discards the session at a check, asks the seller to relink, and runs nothing more', async () => {
    site.inject({ action: 'health', fault: { type: 'captcha' } });
    const run = await sessions().use(
      request(),
      (session, s) => session.read('account', account, s),
      signal(),
    );
    expect(run).toMatchObject({
      type: 'ran',
      result: { ok: false, failure: { kind: 'challenge', challenge: 'captcha' } },
    });
    const connectionRow = await database.db
      .selectFrom('marketplace_connection')
      .select(['status', 'token_ciphertext', 'last_error'])
      .where('id', '=', connection.id)
      .executeTakeFirstOrThrow();
    expect(connectionRow).toMatchObject({ status: 'reauth_required', token_ciphertext: null });
    expect(connectionRow.last_error).toContain('CAPTCHA');
    const tasks = await database.db
      .selectFrom('user_task')
      .select(['kind', 'status'])
      .where('account_id', '=', accountId)
      .execute();
    expect(tasks).toEqual([{ kind: 'reconnect', status: 'open' }]);
    const [recorded] = await runs();
    expect(recorded).toMatchObject({
      outcome: 'challenge',
      challenge_kind: 'captcha',
      failed_step: 'open the account',
      error_code: 'challenge',
    });
    expect(screenshots.saved.has(recorded?.screenshot_key ?? '')).toBe(true);

    const requests = site.requests.length;
    expect(
      await sessions().use(
        request(),
        (session, s) => session.read('account', account, s),
        signal(),
      ),
    ).toEqual({ type: 'no_session' });
    expect(site.requests).toHaveLength(requests);
  });

  it("keeps each seller to the marketplace's runs per hour", async () => {
    const limited = sessions({ limits: { runsPerHour: 2, runsPerDay: 100 } });
    for (let run = 0; run < 2; run += 1) {
      expect(
        await limited.use(request(), (session, s) => session.read('account', account, s), signal()),
      ).toMatchObject({ type: 'ran' });
    }
    const third = await limited.use(
      request(),
      (session, s) => session.read('account', account, s),
      signal(),
    );
    expect(third.type).toBe('rate_limited');
    const wait = third.type === 'rate_limited' ? third.retryAfterMs : 0;
    expect(wait).toBeGreaterThan(3_500_000);
    expect(wait).toBeLessThanOrEqual(3_600_000);
    expect(await runs()).toHaveLength(2);
  });

  it("never opens two sessions in one seller's account at once", async () => {
    await database.db.connection().execute(async (other) => {
      await sql`select pg_advisory_lock(hashtextextended(${`automation:${connection.id}`}, 0))`.execute(
        other,
      );
      try {
        expect(
          await sessions().use(
            request(),
            (session, s) => session.read('account', account, s),
            signal(),
          ),
        ).toEqual({ type: 'busy', retryAfterMs: 30_000 });
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${`automation:${connection.id}`}, 0))`.execute(
          other,
        );
      }
    });
    expect(await runs()).toEqual([]);
  });

  it("pauses between a seller's sessions", async () => {
    const paced = sessions({ pacing: { ...profile.pacing, sessionGapMs: [400, 400] } });
    await paced.use(request(), (session, s) => session.read('account', account, s), signal());
    const started = Date.now();
    await paced.use(request(), (session, s) => session.read('account', account, s), signal());
    const [first, second] = await runs();
    expect(
      (second?.started_at.getTime() ?? 0) - (first?.started_at.getTime() ?? 0),
    ).toBeGreaterThanOrEqual(390);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('has nothing to run for a connection that is not an automation one', async () => {
    const other = { ...connection, id: '0199a1f0-0000-7000-8000-00000000abcd' };
    expect(
      await sessions().use(
        { ...request(), connection: other },
        (session, s) => session.read('account', account, s),
        signal(),
      ),
    ).toEqual({ type: 'no_session' });
  });
});
