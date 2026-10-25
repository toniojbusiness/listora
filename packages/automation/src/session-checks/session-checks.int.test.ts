/**
 * Session checks end to end on real Postgres, headless Chromium, and the fake site: linking
 * asks for a check, the runner's check passes only when the marketplace shows the seller's
 * account, a rejected session fails and waits for a relink, a marketplace that can't be read is
 * tried again and then fails visibly, and a job for an older link records nothing.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { LocalTokenVault, SessionVault } from '@listora/connections';

import { RunnerSessions } from '../adapter/runner-sessions.ts';
import { RUNNER_TASKS, runnerWorkWaiting } from '../dispatch.ts';
import { createFakeSiteAdapter } from '../fake-site/fake-site-adapter.ts';
import { FakeAutomationSite } from '../fake-site/fake-site.ts';
import { linkAutomationSession } from '../link.ts';
import type { AutomationProfile } from '../profiles.ts';
import { fakeSiteProfile, silentLogger, stubPhotos, testRunner } from '../test-support.ts';
import { runSessionCheck, SESSION_CHECK_ATTEMPTS, type SessionCheckDependencies } from './job.ts';
import { SESSION_CHECK_TASK, sessionCheckJobKey } from './schedule.ts';

describe('session checks (real Postgres, headless Chromium)', () => {
  let database: MigratedDatabase;
  let site: FakeAutomationSite;
  let profile: AutomationProfile;
  let deps: SessionCheckDependencies;
  let accountId: string;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger: silentLogger,
  });
  const { runner } = testRunner({ stepTimeoutMs: 3_000 });

  beforeAll(async () => {
    database = await createMigratedDatabase('session_checks', { jobQueue: true, max: 8 });
    site = await FakeAutomationSite.start();
    profile = fakeSiteProfile(site, 'poshmark');
    const sessions = new RunnerSessions({
      db: database.db,
      vault,
      runner,
      profile: (marketplace) => (marketplace === 'poshmark' ? profile : undefined),
      logger: silentLogger,
    });
    deps = {
      db: database.db,
      automation: {
        poshmark: createFakeSiteAdapter({
          marketplace: 'poshmark',
          siteUrl: site.url,
          profile,
          sessions,
          photos: stubPhotos,
          logger: silentLogger,
        }),
      },
      logger: silentLogger,
      retryDelayMs: () => 0,
    };
  });

  afterAll(async () => {
    await runner.close();
    await site.close();
    await database.close();
  });

  beforeEach(async () => {
    site.clearFaults();
    await sql`delete from graphile_worker._private_jobs`.execute(database.db);
    accountId = await insertAccount(database.db);
  });

  const link = (cookie = site.issueSession(accountId)) =>
    linkAutomationSession(
      database.db,
      { vault, profile },
      { accountId, marketplace: 'poshmark', cookies: [cookie] },
    );

  const checkRow = (connectionId: string) =>
    database.db
      .selectFrom('session_check')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();

  const connection = (connectionId: string) =>
    database.db
      .selectFrom('marketplace_connection')
      .select(['status', 'token_ciphertext', 'last_error'])
      .where('account_id', '=', accountId)
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();

  const jobs = async (connectionId: string) => {
    const { rows } = await sql<{ task_identifier: string; run_at: Date }>`
      select task_identifier, run_at from graphile_worker.jobs
      where key = ${sessionCheckJobKey(connectionId)}
    `.execute(database.db);
    return rows;
  };

  const run = (
    linked: { connectionId: string; checkId: string },
    overrides: Partial<SessionCheckDependencies> = {},
  ) =>
    runSessionCheck(
      { ...deps, ...overrides },
      { accountId, connectionId: linked.connectionId, checkId: linked.checkId },
      new AbortController().signal,
    );

  it('asks the runner to check a session as it is linked, before the first sale check', async () => {
    const linked = await link();
    expect(await checkRow(linked.connectionId)).toMatchObject({
      check_id: linked.checkId,
      status: 'pending',
      attempts: 0,
      finished_at: null,
    });
    expect((await jobs(linked.connectionId)).map((job) => job.task_identifier)).toEqual([
      SESSION_CHECK_TASK,
    ]);
    expect(RUNNER_TASKS).toContain(SESSION_CHECK_TASK);
    expect(await runnerWorkWaiting(database.db)).toBe(true);
    const { rows } = await sql<{ task_identifier: string }>`
      select task_identifier from graphile_worker.jobs order by id
    `.execute(database.db);
    expect(rows.map((row) => row.task_identifier)[0]).toBe(SESSION_CHECK_TASK);
  });

  it('passes when the marketplace shows the seller their account, without changing anything', async () => {
    const linked = await link();
    const before = site.requests.length;
    await run(linked);
    expect(await checkRow(linked.connectionId)).toMatchObject({
      status: 'passed',
      attempts: 1,
      failure_code: null,
    });
    expect((await checkRow(linked.connectionId)).finished_at).not.toBeNull();
    // One read of the account page, nothing else.
    expect(site.requests.slice(before).map((request) => [request.method, request.action])).toEqual([
      ['GET', 'health'],
    ]);
    expect(await connection(linked.connectionId)).toMatchObject({ status: 'connected' });
  });

  it('fails and asks for a relink when the marketplace rejects the session', async () => {
    const stale = site.issueSession(accountId);
    stale.value = 'not-a-session-the-site-knows';
    const linked = await link(stale);
    await run(linked);
    const check = await checkRow(linked.connectionId);
    expect(check).toMatchObject({ status: 'failed', failure_code: 'session_rejected' });
    expect(check.failure_message).toContain('Poshmark');
    // The vault discarded the session: nothing retries around the rejection.
    expect(await connection(linked.connectionId)).toMatchObject({
      status: 'reauth_required',
      token_ciphertext: null,
    });
  });

  it('fails on a CAPTCHA without passing it', async () => {
    const linked = await link();
    site.inject({ action: 'health', fault: { type: 'captcha' } });
    await run(linked);
    expect(await checkRow(linked.connectionId)).toMatchObject({
      status: 'failed',
      failure_code: 'captcha',
    });
    expect((await connection(linked.connectionId)).status).toBe('reauth_required');
  });

  it('tries a marketplace that cannot be read again, then fails visibly, keeping the session', async () => {
    const linked = await link();
    site.inject({
      action: 'health',
      fault: { type: 'server_error' },
      times: SESSION_CHECK_ATTEMPTS,
    });
    for (let attempt = 1; attempt < SESSION_CHECK_ATTEMPTS; attempt += 1) {
      await run(linked);
      expect(await checkRow(linked.connectionId)).toMatchObject({
        status: 'pending',
        attempts: attempt,
      });
      expect((await jobs(linked.connectionId)).map((job) => job.task_identifier)).toEqual([
        SESSION_CHECK_TASK,
      ]);
    }
    await run(linked);
    const check = await checkRow(linked.connectionId);
    expect(check).toMatchObject({ status: 'failed', attempts: SESSION_CHECK_ATTEMPTS });
    expect(check.failure_message).toBe(
      "Listora couldn't check your Poshmark login just now. Link it again to retry.",
    );
    expect((await connection(linked.connectionId)).status).toBe('connected');
  });

  it('never reports a marketplace without an automation adapter as linked', async () => {
    const linked = await link();
    await run(linked, { automation: {} });
    expect(await checkRow(linked.connectionId)).toMatchObject({
      status: 'failed',
      failure_code: 'automation_unavailable',
    });
  });

  it('records nothing for a link the seller has since replaced', async () => {
    const first = await link();
    const second = await link();
    expect(second.checkId).not.toBe(first.checkId);
    // The relink's job replaced the first link's.
    expect(await jobs(first.connectionId)).toHaveLength(1);
    await run(first);
    expect(await checkRow(first.connectionId)).toMatchObject({
      check_id: second.checkId,
      status: 'pending',
      attempts: 0,
    });
    await run(second);
    expect((await checkRow(first.connectionId)).status).toBe('passed');
  });

  it('lets a seller log in on the fake site by hand, as on the app linking screen', async () => {
    const response = await fetch(`${site.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'closet_queen', password: 'hunter2' }),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    const token = /fake_sid=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    expect(token === undefined ? false : site.sessionValid(token)).toBe(true);
    expect(JSON.stringify(site.requests)).not.toContain('hunter2');

    const refused = await fetch(`${site.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'closet_queen', password: '' }),
      redirect: 'manual',
    });
    expect(refused.status).toBe(200);
    expect(refused.headers.get('set-cookie')).toBeNull();
  });
});
