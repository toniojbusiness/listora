import { randomUUID } from 'node:crypto';

import { subjectSha256 } from '@listora/accounts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';
import { CognitoAuthDriver } from './cognito-driver.ts';
import { FakeCognitoPool, nowSeconds, TEST_POOL } from './cognito-test-support.ts';

/** The API with `AUTH_DRIVER=cognito`, against a fake user pool and the real database. */
describe('Cognito sign-in through the API (real Postgres)', () => {
  let pool: FakeCognitoPool;
  let api: TestApi;

  beforeAll(async () => {
    pool = await FakeCognitoPool.start();
    api = await createTestApi('cognito', {
      auth: new CognitoAuthDriver({ config: TEST_POOL, jwksUrl: pool.jwksUrl }),
    });
  });

  afterAll(async () => {
    await api.close();
    await pool.close();
  });

  async function userOf(sub: string) {
    return api.db
      .selectFrom('app_user')
      .innerJoin('membership', 'membership.user_id', 'app_user.id')
      .innerJoin('account', 'account.id', 'membership.account_id')
      .select([
        'app_user.id as userId',
        'app_user.auth_provider',
        'app_user.email',
        'account.id as accountId',
        'account.name',
        'account.sku_prefix',
        'membership.role',
      ])
      .where('app_user.auth_subject', '=', sub)
      .execute();
  }

  it('maps the Cognito subject to one user and account, from ID and access tokens alike', async () => {
    const sub = randomUUID();
    const idToken = await pool.idToken(sub, 'grace.hopper@example.com');
    const created = await api.call('createItem', { token: idToken, body: {} });
    expect(created.status).toBe(201);
    expect(created.body.sku).toMatch(/^GH-\d{6}$/);

    const accessToken = await pool.accessToken(sub);
    const listed = await api.call('listItems', { token: accessToken });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((item) => item.id)).toEqual([created.body.id]);

    expect(await userOf(sub)).toEqual([
      expect.objectContaining({
        auth_provider: 'cognito',
        email: 'grace.hopper@example.com',
        name: 'grace.hopper@example.com',
        sku_prefix: 'GH',
        role: 'owner',
      }),
    ]);
  });

  it('provisions from an access token too, without an email', async () => {
    const sub = randomUUID();
    expect((await api.call('listItems', { token: await pool.accessToken(sub) })).status).toBe(200);
    expect(await userOf(sub)).toEqual([
      expect.objectContaining({ email: null, name: 'My account', sku_prefix: 'LS' }),
    ]);
  });

  it('answers 401 for tokens that fail verification, and creates no user for them', async () => {
    const sub = randomUUID();
    const tokens = [
      await pool.accessToken(sub, { client_id: 'someoneelsesclient0000000a' }),
      await pool.accessToken(sub, { iss: 'https://cognito-idp.us-east-1.amazonaws.com/x_y' }),
      await pool.accessToken(sub, {}, { issuedAt: Math.floor(Date.now() / 1000) - 7200 }),
      await pool.accessToken(sub, {}, { foreignKey: true }),
    ];
    for (const token of tokens) {
      const response = await api.call('listItems', { token });
      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
    expect(await userOf(sub)).toEqual([]);
  });

  it('answers a retryable 503, never a pass, while the signing keys cannot be fetched', async () => {
    // A new driver has no cached keys, so it must fetch them.
    const isolated = await createTestApi('cognito_jwks', {
      auth: new CognitoAuthDriver({ config: TEST_POOL, jwksUrl: pool.jwksUrl }),
    });
    pool.jwksStatus = 503;
    try {
      const response = await isolated.call('listItems', { token: await pool.accessToken('x') });
      expect(response.status).toBe(503);
      expect(response.error).toMatchObject({ code: 'service_unavailable', retryable: true });
      expect(response.headers['retry-after']).toBe('30');
    } finally {
      pool.jwksStatus = 200;
      await isolated.close();
    }
  });

  it('deletes the Cognito user after the account, and ends every earlier token', async () => {
    const sub = randomUUID();
    const idToken = await pool.idToken(sub, 'ada.lovelace@example.com');
    const accessToken = await pool.accessToken(sub);
    await api.call('createItem', { token: idToken, body: {} });

    const deleted = await api.call('deleteAccount', { token: accessToken });
    expect(deleted.status).toBe(200);
    expect(await userOf(sub)).toEqual([]);
    // The worker deletes the Cognito user. Until then Cognito can still issue tokens, for
    // example on a refresh, and none of them may provision a new account. (Moving the
    // deletion 10 seconds back lets the test issue such a token after it.)
    expect(api.accountDeletions.cognito.deleted).toEqual([]);
    await sql`
      update deleted_identity set deleted_at = deleted_at - interval '10 seconds'
      where auth_subject_sha256 = ${subjectSha256(sub)}
    `.execute(api.db);
    const refreshed = await pool.accessToken(sub, {}, { issuedAt: nowSeconds() - 5 });
    for (const token of [idToken, accessToken, refreshed]) {
      expect((await api.call('listItems', { token })).status).toBe(401);
    }

    expect(await api.accountDeletions.runAll()).toEqual(['completed']);
    expect(api.accountDeletions.cognito.deleted).toEqual([`signinwithapple_${sub}`]);
    for (const token of [idToken, accessToken, refreshed]) {
      expect((await api.call('listItems', { token })).status).toBe(401);
    }
    expect(await userOf(sub)).toEqual([]);

    // Signing in again creates a new Cognito user (a new `sub`) and a new, empty account.
    const again = await pool.idToken(randomUUID(), 'ada.lovelace@example.com');
    const items = await api.call('listItems', { token: again });
    expect(items.status).toBe(200);
    expect(items.body.data).toEqual([]);
  });

  it('keeps trying to delete the Cognito user while Cognito fails', async () => {
    const sub = randomUUID();
    const token = await pool.idToken(sub, 'carl.cognito@example.com');
    await api.call('createItem', { token, body: {} });
    const { cognito } = api.accountDeletions;
    cognito.failWith = new Error('AccessDeniedException');
    try {
      // The deletion does not depend on Cognito: the data is gone at once.
      expect((await api.call('deleteAccount', { token })).status).toBe(200);
      expect(await userOf(sub)).toEqual([]);
      expect(await api.accountDeletions.runAll()).toEqual(['retrying']);
      const [job] = await api.accountDeletions.jobs();
      expect(job?.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
      const later = await pool.idToken(
        sub,
        'carl.cognito@example.com',
        {},
        { issuedAt: nowSeconds() + 2 },
      );
      expect((await api.call('listItems', { token: later })).status).toBe(401);
      expect(await userOf(sub)).toEqual([]);
    } finally {
      cognito.failWith = undefined;
    }
    expect(await api.accountDeletions.runAll()).toEqual(['completed']);
    expect(cognito.deleted).toContain(`signinwithapple_${sub}`);
    expect(await api.accountDeletions.jobs()).toEqual([]);
  });
});
