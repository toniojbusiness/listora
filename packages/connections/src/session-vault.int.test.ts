import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import { createLogger } from '@listora/shared';

import { LocalTokenVault } from './local-vault.ts';
import type { SessionCookie } from './session.ts';
import { ConnectionModeConflictError, SessionCookieError, SessionVault } from './session-vault.ts';

const NOW = 1_800_000_000;
const DOMAINS = ['mercari.com'];

function cookie(overrides: Partial<SessionCookie> = {}): SessionCookie {
  return {
    name: 'sid',
    value: 'session-secret-value',
    domain: '.mercari.com',
    path: '/',
    expires: NOW + 86_400,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides,
  };
}

describe('SessionVault (real Postgres)', () => {
  let database: MigratedDatabase;
  let accountId: string;
  const logger = createLogger({ service: 'test', level: 'silent' });
  let now = NOW;
  const vault = new SessionVault({
    vault: new LocalTokenVault(randomBytes(32)),
    logger,
    nowSeconds: () => now,
  });

  beforeAll(async () => {
    database = await createMigratedDatabase('session_vault');
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    now = NOW;
    accountId = await insertAccount(database.db);
  });

  const connectionRow = (connectionId: string) =>
    database.db
      .selectFrom('marketplace_connection')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow();

  const reconnectTasks = () =>
    database.db
      .selectFrom('user_task')
      .select(['status', 'urgency', 'deep_link', 'payload'])
      .where('account_id', '=', accountId)
      .where('kind', '=', 'reconnect')
      .orderBy('created_at')
      .execute();

  async function link(cookies: SessionCookie[] = [cookie()]) {
    return vault.linkSession(database.db, {
      accountId,
      marketplace: 'mercari',
      cookies,
      cookieDomains: DOMAINS,
      displayName: 'closet-seller',
    });
  }

  it('stores the session encrypted on an automation connection and loads it back', async () => {
    const linked = await link([cookie(), cookie({ name: 'csrf', value: 'c', expires: -1 })]);
    const row = await connectionRow(linked.connectionId);
    expect(row).toMatchObject({
      mode: 'automation',
      status: 'connected',
      display_name: 'closet-seller',
      credential_version: 0,
    });
    expect(row.token_ciphertext?.includes(Buffer.from('session-secret-value'))).toBe(false);

    const loaded = await vault.load(database.db, { accountId, connectionId: linked.connectionId });
    expect(loaded).toEqual({
      accountId,
      connectionId: linked.connectionId,
      marketplace: 'mercari',
      version: 0,
      cookies: [cookie(), cookie({ name: 'csrf', value: 'c', expires: -1 })],
    });
  });

  it("refuses cookies of other sites, expired ones, and none, and a marketplace's API connection", async () => {
    await expect(link([cookie(), cookie({ domain: '.tracker.example' })])).rejects.toThrow(
      SessionCookieError,
    );
    await expect(link([cookie({ expires: NOW - 1 })])).rejects.toThrow('expired');
    await expect(link([])).rejects.toThrow(SessionCookieError);
    await database.db
      .insertInto('marketplace_connection')
      .values({
        account_id: accountId,
        marketplace: 'mercari',
        mode: 'api',
        external_user_id: 'seller-1',
        token_ciphertext: Buffer.from('oauth'),
      })
      .execute();
    await expect(link()).rejects.toThrow(ConnectionModeConflictError);
  });

  it('discards a rejected session, asks once to relink, and takes a new session', async () => {
    const linked = await link();
    const key = { accountId, connectionId: linked.connectionId };
    const reason = { kind: 'captcha' as const, message: 'Mercari asked for a CAPTCHA.' };
    expect(await vault.markNeedsRelink(database.db, { ...key, version: 0 }, reason)).toBe(true);
    // A second report about the same session changes nothing.
    expect(await vault.markNeedsRelink(database.db, { ...key, version: 0 }, reason)).toBe(false);

    expect(await connectionRow(linked.connectionId)).toMatchObject({
      status: 'reauth_required',
      token_ciphertext: null,
      credential_version: 1,
      last_error: 'Mercari asked for a CAPTCHA.',
      last_error_code: 'captcha',
    });
    expect(await vault.load(database.db, key)).toBeNull();
    expect(await reconnectTasks()).toEqual([
      {
        status: 'open',
        urgency: 'high',
        deep_link: 'listora://connections/mercari',
        payload: {
          connectionId: linked.connectionId,
          marketplace: 'mercari',
          reason: 'captcha',
          message: 'Mercari asked for a CAPTCHA.',
        },
      },
    ]);

    const relinked = await link([cookie({ value: 'fresh' })]);
    expect(relinked).toEqual({ connectionId: linked.connectionId, version: 2 });
    expect(await connectionRow(linked.connectionId)).toMatchObject({
      status: 'connected',
      last_error: null,
    });
    expect((await reconnectTasks()).map((task) => task.status)).toEqual(['done']);
    expect((await vault.load(database.db, key))?.cookies[0]?.value).toBe('fresh');
  });

  it('never lets an older session overwrite or discard a newer one', async () => {
    const linked = await link();
    const key = { accountId, connectionId: linked.connectionId };
    const stale = await vault.load(database.db, key);
    if (stale === null) throw new Error('no session');
    await link([cookie({ value: 'relinked' })]);

    expect(await vault.rotate(database.db, stale, [cookie({ value: 'rotated' })], DOMAINS)).toBe(
      false,
    );
    const reason = { kind: 'session_rejected' as const, message: 'Logged out.' };
    expect(
      await vault.markNeedsRelink(database.db, { ...key, version: stale.version }, reason),
    ).toBe(false);
    const current = await vault.load(database.db, key);
    expect(current?.cookies.map((c) => c.value)).toEqual(['relinked']);
    expect(await reconnectTasks()).toEqual([]);
  });

  it("stores the marketplace's refreshed cookies, dropping other sites' and expired ones", async () => {
    const linked = await link();
    const key = { accountId, connectionId: linked.connectionId };
    const loaded = await vault.load(database.db, key);
    if (loaded === null) throw new Error('no session');
    const refreshed = [
      cookie({ value: 'rotated' }),
      cookie({ name: 'ad', domain: '.ads.example' }),
      cookie({ name: 'gone', expires: NOW - 10 }),
    ];
    expect(await vault.rotate(database.db, loaded, refreshed, DOMAINS)).toBe(true);
    const rotated = await vault.load(database.db, key);
    expect(rotated?.version).toBe(1);
    expect(rotated?.cookies).toEqual([cookie({ value: 'rotated' })]);
    // The loaded copy is now stale.
    expect(await vault.rotate(database.db, loaded, refreshed, DOMAINS)).toBe(false);
  });

  it('treats a session it cannot decrypt, or one copied to another connection, as rejected', async () => {
    const linked = await link();
    const other = await vault.linkSession(database.db, {
      accountId,
      marketplace: 'poshmark',
      cookies: [cookie({ domain: '.poshmark.com' })],
      cookieDomains: ['poshmark.com'],
    });
    const { token_ciphertext: copied } = await connectionRow(linked.connectionId);
    await database.db
      .updateTable('marketplace_connection')
      .set({ token_ciphertext: copied })
      .where('id', '=', other.connectionId)
      .execute();

    expect(
      await vault.load(database.db, { accountId, connectionId: other.connectionId }),
    ).toBeNull();
    expect(await connectionRow(other.connectionId)).toMatchObject({
      status: 'reauth_required',
      token_ciphertext: null,
    });
    expect((await reconnectTasks()).map((task) => task.payload['reason'])).toEqual([
      'session_unreadable',
    ]);

    const otherKey = new SessionVault({ vault: new LocalTokenVault(randomBytes(32)), logger });
    expect(
      await otherKey.load(database.db, { accountId, connectionId: linked.connectionId }),
    ).toBeNull();
  });

  it('asks to relink once every cookie of the session has expired', async () => {
    const linked = await link();
    now = NOW + 2 * 86_400;
    expect(
      await vault.load(database.db, { accountId, connectionId: linked.connectionId }),
    ).toBeNull();
    expect(await connectionRow(linked.connectionId)).toMatchObject({ status: 'reauth_required' });
    expect((await reconnectTasks()).map((task) => task.payload['reason'])).toEqual([
      'session_rejected',
    ]);
  });
});
