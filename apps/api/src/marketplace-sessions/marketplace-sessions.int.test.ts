import { randomUUID } from 'node:crypto';

import {
  loadAutomationSettings,
  SALE_CHECK_TASK,
  saleCheckJobKey,
  SESSION_CHECK_TASK,
} from '@listora/automation';
import { SESSION_CHECK_DEADLINE_MS } from '@listora/connections';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

/**
 * These suites cover sessions checked by the cloud browser runner, so every marketplace runs in
 * the cloud here; the phone's checks are in phone/phone.int.test.ts.
 */
const IN_THE_CLOUD = {
  automationEnv: {
    AUTOMATION_POSHMARK_CLOUD_ALLOWED: 'true',
    AUTOMATION_POSHMARK_RUNS_ON: 'cloud',
    AUTOMATION_MERCARI_CLOUD_ALLOWED: 'true',
    AUTOMATION_MERCARI_RUNS_ON: 'cloud',
    AUTOMATION_DEPOP_CLOUD_ALLOWED: 'true',
    AUTOMATION_DEPOP_RUNS_ON: 'cloud',
  },
};

const OWNER = 'linking.owner@example.com';
const OTHER = 'linking.other@example.com';
const EBAY_SELLER = 'linking.ebay@example.com';

/** A value no response, log line, or stored row other than the vault's ciphertext may hold. */
const SECRET = `posh-session-${randomUUID()}`;
const NOW_SECONDS = Math.floor(Date.now() / 1000);

function cookie(overrides: Record<string, unknown> = {}) {
  return {
    name: 'jwt',
    value: SECRET,
    domain: '.poshmark.com',
    path: '/',
    expires: NOW_SECONDS + 86_400,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    ...overrides,
  };
}

describe('marketplace sessions (real Postgres)', () => {
  let api: TestApi;
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    api = await createTestApi('sessions', IN_THE_CLOUD);
    token = await api.signIn(OWNER);
    otherToken = await api.signIn(OTHER);
  });

  afterAll(async () => {
    await api.close();
  });

  const link = (marketplace: string, body: unknown, options: { as?: string; key?: string } = {}) =>
    api.call('linkMarketplaceSession', {
      token: options.as ?? token,
      params: { marketplace },
      body,
      ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
    });

  const get = (marketplace: string, as = token) =>
    api.call('getMarketplaceSession', { token: as, params: { marketplace } });

  const connectionOf = async (email: string, marketplace: string) => {
    const tenant = await api.tenantOf(email);
    return api.db
      .selectFrom('marketplace_connection')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .where('marketplace', '=', marketplace as 'poshmark')
      .executeTakeFirst();
  };

  const checkOf = async (email: string, marketplace: string) => {
    const tenant = await api.tenantOf(email);
    return api.db
      .selectFrom('session_check')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .where('marketplace', '=', marketplace as 'poshmark')
      .executeTakeFirstOrThrow();
  };

  const checkJobs = async () => {
    // The `jobs` view has no payload; the table behind it does.
    const { rows } = await sql<{ payload: { checkId: string; connectionId: string } }>`
      select job.payload from graphile_worker._private_jobs job
      join graphile_worker._private_tasks task on task.id = job.task_id
      where task.identifier = ${SESSION_CHECK_TASK}
    `.execute(api.db);
    return rows.map((row) => row.payload);
  };

  it('lists the marketplaces linked by signing in, each with its own sign-in page', async () => {
    const listed = await api.call('listMarketplaceSessions', { token: otherToken });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([
      {
        marketplace: 'poshmark',
        status: 'not_linked',
        statusDisplay: { tone: 'neutral', label: 'Not linked' },
        login: {
          url: 'https://poshmark.com/login',
          cookieDomains: ['poshmark.com'],
          emailsSignInLinks: false,
        },
      },
      {
        marketplace: 'mercari',
        status: 'not_linked',
        statusDisplay: { tone: 'neutral', label: 'Not linked' },
        login: {
          url: 'https://www.mercari.com/login/',
          cookieDomains: ['mercari.com'],
          emailsSignInLinks: false,
        },
      },
      {
        marketplace: 'depop',
        status: 'not_linked',
        statusDisplay: { tone: 'neutral', label: 'Not linked' },
        login: {
          url: 'https://www.depop.com/login/',
          cookieDomains: ['depop.com'],
          emailsSignInLinks: true,
        },
      },
      {
        marketplace: 'ebay',
        status: 'not_linked',
        statusDisplay: { tone: 'neutral', label: 'Not linked' },
        login: {
          url: 'https://signin.ebay.com/signin/',
          cookieDomains: ['ebay.com'],
          emailsSignInLinks: false,
        },
      },
    ]);
  });

  it('links eBay by signing in until its API is connected, which then takes over', async () => {
    const seller = await api.signIn(EBAY_SELLER);
    const ebayCookie = cookie({ name: 'nonsession', domain: '.ebay.com' });
    expect(
      (await link('ebay', { cookies: [cookie({ domain: '.ebay.co.uk' })] }, { as: seller })).status,
    ).toBe(422);
    const linked = await link('ebay', { cookies: [ebayCookie] }, { as: seller });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      marketplace: 'ebay',
      status: 'checking',
      login: {
        url: 'https://signin.ebay.com/signin/',
        cookieDomains: ['ebay.com'],
        emailsSignInLinks: false,
      },
    });
    const connection = await connectionOf(EBAY_SELLER, 'ebay');
    expect(connection).toMatchObject({ mode: 'automation', status: 'connected' });
    expect(connection?.token_ciphertext?.toString('utf8')).not.toContain(SECRET);
    expect((await checkOf(EBAY_SELLER, 'ebay')).status).toBe('pending');

    // The seller connects eBay's API (as completeAuthorization stores a grant on the account's
    // connection): the same connection, and so the same listings, switch to the API.
    await api.db
      .updateTable('marketplace_connection')
      .set({ mode: 'api', token_ciphertext: Buffer.from('sealed tokens') })
      .where('id', '=', connection?.id ?? '')
      .execute();
    expect((await get('ebay', seller)).body).toMatchObject({
      status: 'api_connected',
      statusDisplay: { label: 'Connected through the eBay API' },
    });
    const again = await link('ebay', { cookies: [ebayCookie] }, { as: seller });
    expect(again.status).toBe(409);
    expect(again.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message: 'eBay is connected through its API, so there is nothing to sign in to.',
    });
  });

  it('stores the session in the vault, asks the runner to check it, and reports checking', async () => {
    const response = await link('poshmark', {
      cookies: [cookie(), cookie({ name: 'ui', value: 'dark', httpOnly: false, expires: -1 })],
      displayName: ' closet_queen ',
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      marketplace: 'poshmark',
      status: 'checking',
      statusDisplay: { tone: 'checking', label: 'Checking...' },
      displayName: 'closet_queen',
      login: {
        url: 'https://poshmark.com/login',
        cookieDomains: ['poshmark.com'],
        emailsSignInLinks: false,
      },
    });
    expect(response.body.linkedAt).toBeDefined();
    expect(response.body.checkedAt).toBeUndefined();

    // Encrypted at rest, and only the vault can read it back.
    const connection = await connectionOf(OWNER, 'poshmark');
    expect(connection).toMatchObject({ mode: 'automation', status: 'connected' });
    expect(connection?.token_ciphertext?.toString('latin1')).not.toContain(SECRET);
    const loaded = await api.vault.load(api.db, {
      accountId: connection?.account_id ?? '',
      connectionId: connection?.id ?? '',
    });
    expect(loaded?.cookies).toEqual([
      { ...cookie(), sameSite: 'Lax' },
      { ...cookie({ name: 'ui', value: 'dark', httpOnly: false, expires: -1 }), sameSite: 'Lax' },
    ]);

    const check = await checkOf(OWNER, 'poshmark');
    expect(check).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await checkJobs()).toContainEqual({
      accountId: connection?.account_id,
      connectionId: connection?.id,
      checkId: check.check_id,
    });

    // The cookie value is in no response, log line, or idempotency record.
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(JSON.stringify(api.logLines)).not.toContain(SECRET);
    const { rows } = await sql<{ row: unknown }>`
      select to_jsonb(r) as row from idempotency_record r
    `.execute(api.db);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('shows linked only once the check passed, and the failure when it did not', async () => {
    const tenant = await api.tenantOf(OWNER);
    const setCheck = (values: Record<string, unknown>) =>
      api.db
        .updateTable('session_check')
        .set({ finished_at: new Date(), ...values })
        .where('account_id', '=', tenant.accountId)
        .where('marketplace', '=', 'poshmark')
        .execute();

    await setCheck({ status: 'passed' });
    const linked = await get('poshmark');
    expect(linked.body).toMatchObject({
      status: 'linked',
      statusDisplay: { tone: 'success', label: 'Linked' },
    });
    expect(linked.body.checkedAt).toBeDefined();
    expect(linked.body.issue).toBeUndefined();

    await setCheck({
      status: 'failed',
      failure_code: 'step_timeout',
      failure_message: "Listora couldn't check your Poshmark sign-in just now.",
    });
    expect((await get('poshmark')).body).toMatchObject({
      status: 'check_failed',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Not confirmed',
        detail:
          "Listora couldn't check your Poshmark sign-in just now. Check again, or link Poshmark again if it keeps failing.",
      },
      issue: {
        code: 'step_timeout',
        message: "Listora couldn't check your Poshmark sign-in just now.",
      },
    });
  });

  it('shows needs relink once the marketplace rejected the session, and relinks in one tap', async () => {
    const connection = await connectionOf(OWNER, 'poshmark');
    if (connection === undefined) throw new Error('no connection');
    await api.vault.markNeedsRelink(
      api.db,
      {
        accountId: connection.account_id,
        connectionId: connection.id,
        version: connection.credential_version,
      },
      { kind: 'session_rejected', message: 'Poshmark logged Listora out. Log in again.' },
    );
    expect((await get('poshmark')).body).toMatchObject({
      status: 'needs_relink',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Sign in again',
        detail: 'Poshmark logged Listora out. Log in again.',
      },
      issue: { message: 'Poshmark logged Listora out. Log in again.' },
    });

    const before = await checkOf(OWNER, 'poshmark');
    const relinked = await link('poshmark', { cookies: [cookie({ value: `${SECRET}-2` })] });
    expect(relinked.status).toBe(201);
    expect(relinked.body.status).toBe('checking');
    const after = await checkOf(OWNER, 'poshmark');
    expect(after).toMatchObject({ status: 'pending', failure_code: null });
    expect(after.check_id).not.toBe(before.check_id);
    // The relink's job replaced the earlier link's.
    const jobs = (await checkJobs()).filter((job) => job.connectionId === connection.id);
    expect(jobs).toEqual([expect.objectContaining({ checkId: after.check_id })]);
    expect(await connectionOf(OWNER, 'poshmark')).toMatchObject({
      status: 'connected',
      last_error: null,
    });
  });

  it('replays a retried link instead of linking twice', async () => {
    const key = randomUUID();
    const body = { cookies: [cookie({ domain: 'www.mercari.com', value: `${SECRET}-m` })] };
    const first = await link('mercari', body, { key });
    const again = await link('mercari', body, { key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const check = await checkOf(OWNER, 'mercari');
    expect((await checkJobs()).filter((job) => job.checkId === check.check_id)).toHaveLength(1);
  });

  it('keeps each account to its own sessions', async () => {
    expect((await get('poshmark', otherToken)).body.status).toBe('not_linked');
  });

  describe('refuses a session it cannot use, storing nothing', () => {
    const refused = [
      ["another site's cookie", { cookies: [cookie(), cookie({ domain: 'evil.example' })] }],
      ['a look-alike domain', { cookies: [cookie({ domain: 'notposhmark.com' })] }],
      ['only expired cookies', { cookies: [cookie({ expires: NOW_SECONDS - 60 })] }],
      ['no cookies', { cookies: [] }],
      ['an unknown sameSite', { cookies: [cookie({ sameSite: 'Lax' })] }],
      ['an unexpected field', { cookies: [cookie({ password: 'hunter2' })] }],
      ['a password field', { cookies: [cookie()], password: 'hunter2' }],
    ] as const;

    it.each(refused)('%s', async (_case, body) => {
      const response = await link('depop', body, { as: otherToken });
      expect(response.status).toBe(422);
      expect(response.error.code).toBe('validation_failed');
      expect(fieldsOf(response).length).toBeGreaterThan(0);
      expect(JSON.stringify(response.error)).not.toContain(SECRET);
      expect(await connectionOf(OTHER, 'depop')).toBeUndefined();
    });
  });

  it('refuses a marketplace connected through its API', async () => {
    const tenant = await api.tenantOf(OTHER);
    await api.db
      .insertInto('marketplace_connection')
      .values({
        account_id: tenant.accountId,
        marketplace: 'depop',
        mode: 'api',
        status: 'connected',
        token_ciphertext: Buffer.from('sealed tokens'),
      })
      .execute();
    expect((await get('depop', otherToken)).body).toMatchObject({
      status: 'api_connected',
      statusDisplay: { label: 'Connected through the Depop API' },
    });
    const response = await link(
      'depop',
      { cookies: [cookie({ domain: 'depop.com' })] },
      {
        as: otherToken,
      },
    );
    expect(response.status).toBe(409);
    expect(response.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message: 'Depop is connected through its API, so there is nothing to sign in to.',
    });
  });

  it('never logs a cookie value, even for refused requests', () => {
    expect(JSON.stringify(api.logLines)).not.toContain(SECRET);
  });
});

/**
 * Link accounts (`getMarketplaceSession`) and Marketplaces (`getConnection`, the health
 * summary) describe a linked session the same way, whatever its check found (on 2026-10-25 Link
 * accounts said "Not confirmed - Link again" while Marketplaces said "Connected"), a check never
 * stays "Checking..." past its deadline, and a sign-in Listora could not confirm can be checked
 * again without signing in again.
 */
describe('a linked session on both screens (real Postgres)', () => {
  const SELLER = 'linking.screens@example.com';
  let api: TestApi;
  let token: string;
  let accountId: string;

  beforeAll(async () => {
    api = await createTestApi('sessions_screens', IN_THE_CLOUD);
    token = await api.signIn(SELLER);
    accountId = (await api.tenantOf(SELLER)).accountId;
  });

  afterAll(async () => {
    await api.close();
  });

  const linkPoshmark = () =>
    api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'poshmark' },
      body: { cookies: [cookie()] },
    });

  const check = () =>
    api.db
      .selectFrom('session_check')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('marketplace', '=', 'poshmark')
      .executeTakeFirstOrThrow();

  const setCheck = (values: Record<string, unknown>) =>
    api.db
      .updateTable('session_check')
      .set(values)
      .where('account_id', '=', accountId)
      .where('marketplace', '=', 'poshmark')
      .execute();

  /** What each screen shows for Poshmark. */
  const screens = async () => {
    const session = await api.call('getMarketplaceSession', {
      token,
      params: { marketplace: 'poshmark' },
    });
    const connection = await api.call('getConnection', {
      token,
      params: { marketplace: 'poshmark' },
    });
    const health = await api.call('getConnectionHealth', { token });
    const listed = health.body.connections.find((entry) => entry.marketplace === 'poshmark');
    expect(listed?.statusDisplay).toEqual(connection.body.statusDisplay);
    return { session: session.body, connection: connection.body, health: health.body };
  };

  const expectSameStatus = async () => {
    const shown = await screens();
    expect(shown.connection.statusDisplay).toEqual(shown.session.statusDisplay);
    expect(shown.connection.lastIssue).toEqual(shown.session.issue);
    return shown;
  };

  it('says Checking... on both while the check runs, and Linked on both once it passed', async () => {
    expect((await linkPoshmark()).status).toBe(201);
    const checking = await expectSameStatus();
    expect(checking.session).toMatchObject({
      status: 'checking',
      statusDisplay: { tone: 'checking', label: 'Checking...' },
    });
    expect(checking.connection).toMatchObject({ mode: 'automation', availableActions: [] });
    expect(checking.health.attention).toEqual([]);

    await setCheck({ status: 'passed', attempts: 1, finished_at: new Date() });
    const linked = await expectSameStatus();
    expect(linked.session).toMatchObject({
      status: 'linked',
      statusDisplay: { tone: 'success', label: 'Linked' },
    });
    expect(linked.connection.availableActions).toEqual([]);
    expect(linked.connection.lastOkAt).toBe(linked.session.checkedAt);
    expect(linked.health.needsAttention).toBe(false);
  });

  it('says Not confirmed on both, with the reason and Retry check, when the check failed', async () => {
    // As the runner recorded it on 2026-10-25, when its browser could not start.
    await setCheck({
      status: 'failed',
      attempts: 3,
      failure_code: 'browser_unavailable',
      failure_message:
        "Listora's browser didn't start, so it couldn't check your Poshmark sign-in. The problem is on Listora's side, not Poshmark's.",
      finished_at: new Date(),
    });
    const failed = await expectSameStatus();
    expect(failed.session).toMatchObject({
      status: 'check_failed',
      statusDisplay: {
        tone: 'action_needed',
        label: 'Not confirmed',
        detail:
          "Listora's browser didn't start, so it couldn't check your Poshmark sign-in. The problem is on Listora's side, not Poshmark's. Check again, or link Poshmark again if it keeps failing.",
      },
      issue: { code: 'browser_unavailable' },
    });
    // Never "Connected" for a session Listora could not confirm.
    expect(failed.connection.availableActions).toEqual(['check']);
    expect(failed.connection.lastOkAt).toBeUndefined();
    expect(failed.health).toMatchObject({
      needsAttention: true,
      banner: { tone: 'action_needed', label: 'Poshmark sign-in not confirmed' },
      attention: [{ marketplace: 'poshmark', reason: 'not_confirmed' }],
    });
  });

  it('checks the same sign-in again without a relink, and lets a running check finish', async () => {
    const before = await check();
    const stored = await api.db
      .selectFrom('marketplace_connection')
      .select(['token_ciphertext', 'credential_version'])
      .where('account_id', '=', accountId)
      .where('marketplace', '=', 'poshmark')
      .executeTakeFirstOrThrow();
    const checked = await api.call('requestConnectionCheck', {
      token,
      params: { marketplace: 'poshmark' },
      idempotencyKey: randomUUID(),
    });
    expect(checked.status).toBe(202);
    expect(checked.body).toMatchObject({
      mode: 'automation',
      statusDisplay: { tone: 'checking', label: 'Checking...' },
      availableActions: [],
    });
    const after = await check();
    expect(after).toMatchObject({ status: 'pending', attempts: 0, failure_code: null });
    expect(after.check_id).not.toBe(before.check_id);
    const { rows } = await sql<{ payload: { checkId: string } }>`
      select job.payload from graphile_worker._private_jobs job
      join graphile_worker._private_tasks task on task.id = job.task_id
      where task.identifier = ${SESSION_CHECK_TASK} and job.key = ${`session-check:${after.connection_id}`}
    `.execute(api.db);
    expect(rows.map((row) => row.payload.checkId)).toEqual([after.check_id]);
    // Its sales are checked again at once too: a failed sale check would wait hours otherwise.
    const sales = await sql<{ key: string }>`
      select job.key from graphile_worker._private_jobs job
      join graphile_worker._private_tasks task on task.id = job.task_id
      where task.identifier = ${SALE_CHECK_TASK}
    `.execute(api.db);
    expect(sales.rows.map((row) => row.key)).toContain(saleCheckJobKey(after.connection_id));
    // The same session: nothing was linked or rewritten.
    expect(
      await api.db
        .selectFrom('marketplace_connection')
        .select(['token_ciphertext', 'credential_version'])
        .where('account_id', '=', accountId)
        .where('marketplace', '=', 'poshmark')
        .executeTakeFirstOrThrow(),
    ).toEqual(stored);
    expect((await expectSameStatus()).session.status).toBe('checking');

    // Asking again while that check runs leaves it to finish.
    const again = await api.call('requestConnectionCheck', {
      token,
      params: { marketplace: 'poshmark' },
      idempotencyKey: randomUUID(),
    });
    expect(again.status).toBe(202);
    expect((await check()).check_id).toBe(after.check_id);
  });

  it('never stays Checking... past the deadline: a check that did not finish is not confirmed', async () => {
    await setCheck({
      status: 'pending',
      finished_at: null,
      failure_code: null,
      failure_message: null,
      requested_at: new Date(api.clock.now - SESSION_CHECK_DEADLINE_MS - 1_000),
    });
    const stuck = await expectSameStatus();
    expect(stuck.session).toMatchObject({
      status: 'check_failed',
      statusDisplay: { tone: 'action_needed', label: 'Not confirmed' },
      issue: {
        code: 'check_timed_out',
        message: "Listora's check of your Poshmark sign-in didn't finish.",
      },
    });
    expect(stuck.connection.availableActions).toEqual(['check']);

    // Retry check starts a new check of the same session.
    const before = await check();
    const checked = await api.call('requestConnectionCheck', {
      token,
      params: { marketplace: 'poshmark' },
      idempotencyKey: randomUUID(),
    });
    expect(checked.status).toBe(202);
    expect((await check()).check_id).not.toBe(before.check_id);
    expect((await expectSameStatus()).session.status).toBe('checking');
  });

  it('says Sign in again on both once the marketplace rejected the session, with no check', async () => {
    const connection = await api.db
      .selectFrom('marketplace_connection')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('marketplace', '=', 'poshmark')
      .executeTakeFirstOrThrow();
    await api.vault.markNeedsRelink(
      api.db,
      { accountId, connectionId: connection.id, version: connection.credential_version },
      { kind: 'captcha', message: 'Poshmark showed a check Listora must not pass. Log in again.' },
    );
    const rejected = await expectSameStatus();
    expect(rejected.session).toMatchObject({
      status: 'needs_relink',
      statusDisplay: { tone: 'action_needed', label: 'Sign in again' },
      issue: { code: 'captcha' },
    });
    expect(rejected.health.attention).toMatchObject([
      { marketplace: 'poshmark', reason: 'reconnect' },
    ]);
    const refused = await api.call('requestConnectionCheck', {
      token,
      params: { marketplace: 'poshmark' },
      idempotencyKey: randomUUID(),
    });
    expect(refused.status).toBe(409);
    expect(refused.error).toMatchObject({
      code: 'invalid_state_transition',
      message: 'Listora has no Poshmark sign-in to check. Link Poshmark again.',
    });
  });
});

describe('marketplace sessions without a token vault (real Postgres)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi('sessions_novault', {
      marketplaceSessions: { vault: undefined, profiles: loadAutomationSettings({}).profiles },
    });
  });

  afterAll(async () => {
    await api.close();
  });

  it('refuses to link, stores nothing, and still lists the marketplaces', async () => {
    const token = await api.signIn(OWNER);
    const response = await api.call('linkMarketplaceSession', {
      token,
      params: { marketplace: 'poshmark' },
      body: { cookies: [cookie()] },
    });
    expect(response.status).toBe(409);
    expect(response.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message: "Listora can't link Poshmark accounts yet.",
    });
    expect(await api.db.selectFrom('marketplace_connection').select('id').execute()).toEqual([]);
    const listed = await api.call('listMarketplaceSessions', { token });
    expect(listed.body.data.map((session) => session.status)).toEqual([
      'not_linked',
      'not_linked',
      'not_linked',
      'not_linked',
    ]);
  });
});
