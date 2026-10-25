import { randomUUID } from 'node:crypto';

import { createMigratedDatabase, insertAccount, type MigratedDatabase } from '@listora/db/testing';
import {
  DEFAULT_LISTING_SETTINGS,
  EbayConnectClient,
  EbayReauthRequiredError,
  FakeEbay,
  loadEbayConfig,
  parseAuthorizationRevocation,
  type OAuthClients,
} from '@listora/marketplaces';
import { createLogger } from '@listora/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  authorizationState,
  completeAuthorization,
  startAuthorization,
  type AuthorizationRow,
} from './authorizations.ts';
import { ConnectionTokens } from './credentials.ts';
import { ConnectionSeller } from './ebay-seller.ts';
import { checkConnectionHealth, runConnectionHealthChecks } from './health.ts';
import { ebayRevocation, recordAuthorizationRevocation } from './revocation.ts';
import { OAuthGrantRevoker } from './revoker.ts';
import { accountConnections } from './store.ts';
import { testTokenVault } from './testing.ts';

describe('eBay connections (real Postgres, fake eBay)', () => {
  let database: MigratedDatabase;
  let fake: FakeEbay;
  let oauth: OAuthClients;
  let devSeller = '';
  const vault = testTokenVault();
  const logs: string[] = [];
  const logger = createLogger({
    service: 'connections-test',
    level: 'trace',
    destination: { write: (line: string) => logs.push(line) },
  });
  const clock = { now: Date.parse('2026-10-24T12:00:00.000Z') };
  const now = () => new Date(clock.now);

  beforeAll(async () => {
    database = await createMigratedDatabase('connections', { max: 20 });
    fake = await FakeEbay.start({ now: () => new Date(clock.now) });
    devSeller = fake.signedInSeller.userId;
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: fake.url });
    const ebay = config === undefined ? undefined : EbayConnectClient.fromConfig(config);
    if (ebay === undefined) throw new Error('no eBay connect client');
    oauth = { ebay };
  });

  afterAll(async () => {
    // No code, token, or state the fake issued ever reached a log line.
    const text = logs.join('\n');
    for (const secret of fake.issuedSecrets()) expect(text).not.toContain(secret);
    await fake.close();
    await database.close();
  });

  beforeEach(() => {
    fake.tokenDelayMs = 0;
    fake.signInAs(devSeller);
  });

  const deps = () => ({ db: database.db, oauth, sealer: vault, logger, now });
  const tokens = () => new ConnectionTokens({ db: database.db, vault, oauth, logger, now });

  async function newTenant(): Promise<{ accountId: string; userId: string }> {
    const accountId = await insertAccount(database.db);
    const user = await database.db
      .insertInto('app_user')
      .values({ auth_provider: 'dev', auth_subject: `${randomUUID()}@example.com` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { accountId, userId: user.id };
  }

  /** Start, consent on the fake eBay page, and the callback, like the app and browser do. */
  async function connect(
    tenant: { accountId: string; userId: string },
    decision: 'agree' | 'decline' = 'agree',
  ): Promise<AuthorizationRow | undefined> {
    const started = await startAuthorization(database.db, oauth.ebay ?? fail(), {
      ...tenant,
      now: now(),
    });
    const redirect = new URL(fake.consent(started.authorizationUrl, decision));
    return completeAuthorization(deps(), {
      marketplace: 'ebay',
      state: redirect.searchParams.get('state') ?? undefined,
      code: redirect.searchParams.get('code') ?? undefined,
      error: redirect.searchParams.get('error') ?? undefined,
    });
  }

  async function connectionOf(accountId: string) {
    const connection = (await accountConnections(database.db, accountId)).get('ebay');
    if (connection === undefined) throw new Error('no eBay connection');
    return connection;
  }

  it('connects: exchanges the code, stores the seller id, scopes, and expiry, and seals the tokens', async () => {
    const tenant = await newTenant();
    const authorization = await connect(tenant);
    expect(authorization).toMatchObject({ status: 'completed', account_id: tenant.accountId });
    const connection = await connectionOf(tenant.accountId);
    expect(connection).toMatchObject({
      id: authorization?.connection_id,
      mode: 'api',
      status: 'connected',
      external_user_id: devSeller,
      display_name: 'listora_dev_seller',
      access_expires_at: new Date(clock.now + 7_200_000),
      refresh_expires_at: new Date(clock.now + 47_304_000_000),
      granted_at: now(),
      last_ok_at: now(),
      last_error: null,
    });
    expect(connection.scopes).toContain('https://api.ebay.com/oauth/api_scope/sell.inventory');
    // The row holds only ciphertext; the worker's credentials open it at use time.
    const ciphertext = connection.token_ciphertext?.toString('latin1') ?? '';
    for (const secret of fake.issuedSecrets()) expect(ciphertext).not.toContain(secret);
    const token = await tokens().accessToken(connection.id);
    expect(token.type).toBe('ok');
    if (token.type !== 'ok') return;
    expect(
      await oauth.ebay?.identify(token.accessToken, {
        signal: AbortSignal.timeout(5_000),
        now: now(),
      }),
    ).toMatchObject({ type: 'identified', externalUserId: devSeller });
  });

  it('records a declined consent as denied and connects nothing', async () => {
    const tenant = await newTenant();
    expect(await connect(tenant, 'decline')).toMatchObject({
      status: 'failed',
      failure_code: 'marketplace_authorization_denied',
      failure_message: "You didn't allow Listora to use your eBay account, so nothing changed.",
    });
    expect((await accountConnections(database.db, tenant.accountId)).size).toBe(0);
  });

  it('ignores a callback without a known state, and uses each state once', async () => {
    expect(
      await completeAuthorization(deps(), {
        marketplace: 'ebay',
        state: undefined,
        code: 'x',
        error: undefined,
      }),
    ).toBeUndefined();
    expect(
      await completeAuthorization(deps(), {
        marketplace: 'ebay',
        state: 'forged-state',
        code: 'x',
        error: undefined,
      }),
    ).toBeUndefined();

    const tenant = await newTenant();
    const started = await startAuthorization(database.db, oauth.ebay ?? fail(), {
      ...tenant,
      now: now(),
    });
    const redirect = new URL(fake.consent(started.authorizationUrl));
    const callback = {
      marketplace: 'ebay' as const,
      state: redirect.searchParams.get('state') ?? undefined,
      code: redirect.searchParams.get('code') ?? undefined,
      error: undefined,
    };
    const first = await completeAuthorization(deps(), callback);
    expect(first?.status).toBe('completed');
    const exchanges = fake.tokenGrants('authorization_code');
    // A reload of the redirect only reads the result: no second exchange.
    expect(await completeAuthorization(deps(), callback)).toEqual(first);
    expect(fake.tokenGrants('authorization_code')).toBe(exchanges);
    // The state belongs to eBay's attempt only.
    expect(
      await completeAuthorization(deps(), { ...callback, marketplace: 'depop' }),
    ).toBeUndefined();
  });

  it('refuses an attempt finished after it expired', async () => {
    const tenant = await newTenant();
    const started = await startAuthorization(database.db, oauth.ebay ?? fail(), {
      ...tenant,
      now: now(),
    });
    const redirect = new URL(fake.consent(started.authorizationUrl));
    clock.now += 11 * 60_000;
    try {
      expect(authorizationState(started.authorization, now())).toBe('expired');
      expect(
        await completeAuthorization(deps(), {
          marketplace: 'ebay',
          state: redirect.searchParams.get('state') ?? undefined,
          code: redirect.searchParams.get('code') ?? undefined,
          error: undefined,
        }),
      ).toMatchObject({ status: 'failed', failure_code: 'marketplace_authorization_failed' });
    } finally {
      clock.now -= 11 * 60_000;
    }
  });

  it('fails visibly when eBay is down during the exchange', async () => {
    const tenant = await newTenant();
    fake.inject({ action: 'token', fault: { type: 'server_error' } });
    expect(await connect(tenant)).toMatchObject({
      status: 'failed',
      failure_message: "eBay couldn't be reached to finish connecting. Connect eBay again.",
    });
    expect((await accountConnections(database.db, tenant.accountId)).size).toBe(0);
  });

  it('reconnects the same seller into the same connection, and refuses another seller', async () => {
    const tenant = await newTenant();
    const first = await connect(tenant);
    const original = await connectionOf(tenant.accountId);
    fake.revokeSellerAccess(devSeller);
    await recordAuthorizationRevocation(database.db, {
      marketplace: 'ebay',
      externalUserId: devSeller,
      revokedAt: now(),
      code: 'revoked_by_seller',
      message: 'You removed Listora.',
    });
    clock.now += 1_000;
    const again = await connect(tenant);
    expect(again?.connection_id).toBe(first?.connection_id);
    const renewed = await connectionOf(tenant.accountId);
    expect(renewed).toMatchObject({ id: original.id, status: 'connected', last_error: null });
    expect(renewed.token_ciphertext?.equals(original.token_ciphertext ?? Buffer.alloc(0))).toBe(
      false,
    );

    fake.signInAs(fake.addSeller({ username: 'other_shop' }).userId);
    expect(await connect(tenant)).toMatchObject({
      status: 'failed',
      failure_message:
        'You signed in to a different eBay account (other_shop) than the one connected to Listora (listora_dev_seller). Sign in to that account to reconnect it.',
    });
    expect((await connectionOf(tenant.accountId)).external_user_id).toBe(devSeller);
    // The other seller's grant was not kept, so Listora revoked it at eBay.
    expect(fake.requests.at(-1)?.action).toBe('revoke');
  });

  describe('credentials', () => {
    async function connectedTenant() {
      const tenant = await newTenant();
      await connect(tenant);
      return { ...tenant, connection: await connectionOf(tenant.accountId) };
    }

    async function expireAccessToken(connectionId: string): Promise<void> {
      fake.expireAccessTokens();
      await database.db
        .updateTable('marketplace_connection')
        .set({ access_expires_at: now() })
        .where('id', '=', connectionId)
        .execute();
    }

    it('hands out the stored token while it is fresh, without asking eBay', async () => {
      const { connection } = await connectedTenant();
      const before = fake.tokenGrants('refresh_token');
      const credentials = tokens();
      const first = await credentials.accessToken(connection.id);
      const second = await credentials.accessToken(connection.id);
      expect(first).toEqual(second);
      expect(fake.tokenGrants('refresh_token')).toBe(before);
    });

    it('refreshes before expiry: once for 10 concurrent callers in one worker', async () => {
      const { connection } = await connectedTenant();
      await database.db
        .updateTable('marketplace_connection')
        .set({ access_expires_at: new Date(clock.now + 60_000) })
        .where('id', '=', connection.id)
        .execute();
      fake.tokenDelayMs = 150;
      const before = fake.tokenGrants('refresh_token');
      const credentials = tokens();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => credentials.accessToken(connection.id)),
      );
      expect(fake.tokenGrants('refresh_token') - before).toBe(1);
      const values = new Set(
        results.map((result) => (result.type === 'ok' ? result.accessToken : '')),
      );
      expect(values.size).toBe(1);
      expect([...values][0]).not.toBe('');
      expect((await connectionOf(connection.account_id)).access_expires_at).toEqual(
        new Date(clock.now + 7_200_000),
      );
    });

    it('refreshes once for 10 workers at the same time (the row lock is the single flight)', async () => {
      const { connection } = await connectedTenant();
      await expireAccessToken(connection.id);
      fake.tokenDelayMs = 150;
      const before = fake.tokenGrants('refresh_token');
      const results = await Promise.all(
        Array.from({ length: 10 }, () => tokens().accessToken(connection.id)),
      );
      expect(fake.tokenGrants('refresh_token') - before).toBe(1);
      expect(results.every((result) => result.type === 'ok')).toBe(true);
      expect(new Set(results.map((r) => (r.type === 'ok' ? r.accessToken : ''))).size).toBe(1);
    });

    it('makes the connection reauth_required at once when eBay refuses the refresh token', async () => {
      const { connection } = await connectedTenant();
      await expireAccessToken(connection.id);
      fake.revokeSellerAccess(devSeller);
      expect(await tokens().accessToken(connection.id)).toMatchObject({
        type: 'reauth_required',
        code: 'grant_revoked',
      });
      expect(await connectionOf(connection.account_id)).toMatchObject({
        status: 'reauth_required',
        last_error_code: 'grant_revoked',
      });
      // Later callers get the same answer without asking eBay again.
      const before = fake.tokenGrants('refresh_token');
      expect((await tokens().accessToken(connection.id)).type).toBe('reauth_required');
      expect(fake.tokenGrants('refresh_token')).toBe(before);
    });

    it('marks the connection degraded, not disconnected, when eBay cannot refresh now', async () => {
      const { connection } = await connectedTenant();
      await expireAccessToken(connection.id);
      fake.inject({ action: 'token', fault: { type: 'rate_limited', retryAfterSeconds: 30 } });
      expect(await tokens().accessToken(connection.id)).toMatchObject({
        type: 'unavailable',
        code: 'rate_limited',
        retryAfterMs: 30_000,
      });
      expect(await connectionOf(connection.account_id)).toMatchObject({
        status: 'degraded',
        last_error_code: 'rate_limited',
      });
      expect((await tokens().accessToken(connection.id)).type).toBe('ok');
      expect((await connectionOf(connection.account_id)).status).toBe('connected');
    });

    it('refreshes a token the marketplace refused before its expiry', async () => {
      const { connection } = await connectedTenant();
      const credentials = tokens();
      const first = await credentials.accessToken(connection.id);
      if (first.type !== 'ok') throw new Error('no token');
      const before = fake.tokenGrants('refresh_token');
      await credentials.invalidate(connection.id, first.accessToken);
      const second = await credentials.accessToken(connection.id);
      expect(second.type === 'ok' && second.accessToken).not.toBe(first.accessToken);
      expect(fake.tokenGrants('refresh_token') - before).toBe(1);
    });

    it('asks to reconnect when the stored tokens cannot be read', async () => {
      const { connection } = await connectedTenant();
      const other = new ConnectionTokens({
        db: database.db,
        vault: testTokenVault(),
        oauth,
        logger,
        now,
      });
      expect(await other.accessToken(connection.id)).toMatchObject({
        type: 'reauth_required',
        code: 'tokens_unreadable',
      });
      expect((await connectionOf(connection.account_id)).status).toBe('reauth_required');
    });
  });

  describe("ConnectionSeller (the eBay adapter's tokens)", () => {
    it("hands the eBay adapter each connection's own token, and asks to connect otherwise", async () => {
      const tenant = await newTenant();
      await connect(tenant);
      const connection = await connectionOf(tenant.accountId);
      const seller = new ConnectionSeller({
        tokens: tokens(),
        listingSettings: DEFAULT_LISTING_SETTINGS,
      });
      const signal = AbortSignal.timeout(5_000);
      const token = await seller.accessToken(
        { id: connection.id, mode: 'api', status: 'connected' },
        signal,
      );
      expect(fake.issuedSecrets()).toContain(token);
      await expect(seller.accessToken(null, signal)).rejects.toBeInstanceOf(
        EbayReauthRequiredError,
      );
      await expect(
        seller.accessToken({ id: connection.id, mode: 'assisted', status: 'connected' }, signal),
      ).rejects.toBeInstanceOf(EbayReauthRequiredError);
      await recordAuthorizationRevocation(database.db, {
        marketplace: 'ebay',
        externalUserId: devSeller,
        revokedAt: new Date(clock.now + 1),
        code: 'revoked_by_seller',
        message: 'You removed Listora.',
      });
      await expect(
        seller.accessToken({ id: connection.id, mode: 'api', status: 'connected' }, signal),
      ).rejects.toThrow('You removed Listora.');
      expect(seller.listingSettings()).toEqual(DEFAULT_LISTING_SETTINGS);
    });
  });

  describe('health checks', () => {
    it('confirms a working connection, and flags and clears problems', async () => {
      const tenant = await newTenant();
      await connect(tenant);
      const { id } = await connectionOf(tenant.accountId);
      const health = { db: database.db, tokens: tokens(), oauth, logger, now };

      clock.now += 3_600_000;
      expect(await checkConnectionHealth(health, id)).toBe('connected');
      expect((await connectionOf(tenant.accountId)).last_ok_at).toEqual(now());

      fake.inject({ action: 'identity', fault: { type: 'server_error' } });
      expect(await checkConnectionHealth(health, id)).toBe('degraded');
      expect(await connectionOf(tenant.accountId)).toMatchObject({
        status: 'degraded',
        last_error_code: 'marketplace_error',
        last_error_at: now(),
      });

      expect(await checkConnectionHealth(health, id)).toBe('connected');
      expect(await connectionOf(tenant.accountId)).toMatchObject({
        status: 'connected',
        last_error: null,
      });

      // The seller removes Listora on eBay: the token stops working and the refresh is refused.
      fake.revokeSellerAccess(devSeller);
      expect(await checkConnectionHealth(health, id)).toBe('reauth_required');
      expect((await connectionOf(tenant.accountId)).status).toBe('reauth_required');
    });

    it('checks every connection that still holds its grant, daily', async () => {
      const healthy = await newTenant();
      await connect(healthy);
      const summary = await runConnectionHealthChecks({
        db: database.db,
        tokens: tokens(),
        oauth,
        logger,
        now,
      });
      expect(summary.checked).toBeGreaterThan(0);
      expect(summary.checked).toBe(summary.connected + summary.degraded + summary.reauthRequired);
      expect((await connectionOf(healthy.accountId)).status).toBe('connected');
    });
  });

  describe('AUTHORIZATION_REVOCATION', () => {
    function notice(userId: string, revocationDate: string) {
      return parseAuthorizationRevocation({
        metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' },
        notification: {
          notificationId: randomUUID(),
          eventDate: revocationDate,
          data: { userId, revokeReason: 'REVOKED_BY_USER', revocationDate },
        },
      });
    }

    it("flips the seller's connections to revoked at once and deletes the tokens", async () => {
      const revoking = fake.addSeller({ username: 'revoker' }).userId;
      fake.signInAs(revoking);
      const first = await newTenant();
      const second = await newTenant();
      await connect(first);
      await connect(second);
      const changed = await recordAuthorizationRevocation(
        database.db,
        ebayRevocation(notice(revoking, new Date(clock.now + 1_000).toISOString())),
        now(),
      );
      expect(changed).toHaveLength(2);
      for (const tenant of [first, second]) {
        expect(await connectionOf(tenant.accountId)).toMatchObject({
          status: 'revoked',
          token_ciphertext: null,
          last_error_code: 'revoked_by_seller',
          last_error:
            "You removed Listora's access in your eBay account settings. Reconnect eBay to keep your listings in sync.",
        });
      }
      const connection = await connectionOf(first.accountId);
      expect(await tokens().accessToken(connection.id)).toMatchObject({
        type: 'reauth_required',
        code: 'authorization_revoked',
      });
      // A repeated delivery changes nothing.
      expect(
        await recordAuthorizationRevocation(
          database.db,
          ebayRevocation(notice(revoking, new Date(clock.now + 1_000).toISOString())),
        ),
      ).toEqual([]);
    });

    it('ignores a notice about a grant older than the current one', async () => {
      const reconnected = fake.addSeller({ username: 'back_again' }).userId;
      fake.signInAs(reconnected);
      const tenant = await newTenant();
      await connect(tenant);
      const older = new Date(clock.now - 60_000).toISOString();
      expect(
        await recordAuthorizationRevocation(
          database.db,
          ebayRevocation(notice(reconnected, older)),
        ),
      ).toEqual([]);
      expect((await connectionOf(tenant.accountId)).status).toBe('connected');
    });
  });

  it("revokes a deleted account's grant through eBay's revocation endpoint", async () => {
    fake.signInAs(fake.addSeller({ username: 'leaving' }).userId);
    const tenant = await newTenant();
    await connect(tenant);
    const connection = await connectionOf(tenant.accountId);
    const revoker = new OAuthGrantRevoker({ vault, oauth, logger });
    const grant = {
      connectionId: connection.id,
      marketplace: 'ebay' as const,
      tokenCiphertext: connection.token_ciphertext ?? Buffer.alloc(0),
    };
    expect(await revoker.revoke(grant)).toBe(true);
    expect((await tokens().accessToken(connection.id)).type).toBe('ok');
    expect(
      await oauth.ebay?.refresh(
        (
          await vault.open(grant.tokenCiphertext, {
            marketplace: 'ebay',
            connectionId: connection.id,
          })
        ).refreshToken,
        { signal: AbortSignal.timeout(5_000), now: now() },
      ),
    ).toMatchObject({ type: 'reauth_required' });
    // Tokens it cannot open are never confirmed revoked.
    expect(await revoker.revoke({ ...grant, tokenCiphertext: Buffer.from('garbage') })).toBe(false);
  });
});

function fail(): never {
  throw new Error('no eBay OAuth client');
}
