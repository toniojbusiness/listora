import { randomUUID } from 'node:crypto';

import { SESSION_CHECK_TASK } from '@listora/automation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, fieldsOf, type TestApi } from '../test-support.ts';

const OWNER = 'linking.owner@example.com';
const OTHER = 'linking.other@example.com';

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
    api = await createTestApi('sessions');
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
        login: { url: 'https://poshmark.com/login', cookieDomains: ['poshmark.com'] },
      },
      {
        marketplace: 'mercari',
        status: 'not_linked',
        statusDisplay: { tone: 'neutral', label: 'Not linked' },
        login: { url: 'https://www.mercari.com/login/', cookieDomains: ['mercari.com'] },
      },
      {
        marketplace: 'depop',
        status: 'not_linked',
        statusDisplay: { tone: 'neutral', label: 'Not linked' },
        login: { url: 'https://www.depop.com/login/', cookieDomains: ['depop.com'] },
      },
    ]);
  });

  it('answers 404 for eBay, which connects through its API', async () => {
    expect((await get('ebay')).status).toBe(404);
    expect((await link('ebay', { cookies: [cookie({ domain: 'ebay.com' })] })).status).toBe(404);
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
      login: { url: 'https://poshmark.com/login', cookieDomains: ['poshmark.com'] },
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
      failure_message:
        "Listora couldn't check your Poshmark login just now. Link it again to retry.",
    });
    expect((await get('poshmark')).body).toMatchObject({
      status: 'check_failed',
      statusDisplay: { tone: 'failed', label: 'Not confirmed - Link again' },
      issue: {
        code: 'step_timeout',
        message: "Listora couldn't check your Poshmark login just now. Link it again to retry.",
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
