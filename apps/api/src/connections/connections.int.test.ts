import { sealOnly } from '@listora/connections';
import { testTokenVault } from '@listora/connections/testing';
import {
  createMarketplaceAdapters,
  EbayConnectClient,
  FAKE_EBAY_RU_NAME,
  FakeEbay,
  loadEbayConfig,
} from '@listora/marketplaces';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApi, type TestApi } from '../test-support.ts';

describe('marketplace connections API (fake eBay)', () => {
  let api: TestApi;
  let fake: FakeEbay;
  const vault = testTokenVault();

  beforeAll(async () => {
    fake = await FakeEbay.start({
      consentRedirect: { acceptUrl: 'http://localhost/v1/connections/ebay/callback' },
    });
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: fake.url });
    const ebay = config === undefined ? undefined : EbayConnectClient.fromConfig(config);
    if (ebay === undefined) throw new Error('no eBay connect client');
    api = await createTestApi('connections', {
      connections: {
        adapters: createMarketplaceAdapters({
          fakeMarketplaceUrl: undefined,
          ebay: undefined,
          depop: undefined,
        }),
        oauth: { ebay },
        sealer: sealOnly(vault),
      },
    });
  });

  afterAll(async () => {
    // Nothing secret reached the API's logs: no code, token, or state, not even in request URLs.
    const logs = JSON.stringify(api.logLines);
    for (const secret of fake.issuedSecrets()) expect(logs).not.toContain(secret);
    for (const state of states) expect(logs).not.toContain(state);
    expect(logs).not.toContain('fake-access-');
    expect(logs).toContain('/v1/connections/ebay/callback');
    await api.close();
    await fake.close();
  });

  const states: string[] = [];

  /** Starts an attempt and returns it with the consent URL the app would open. */
  async function start(token: string) {
    const started = await api.call('startConnectionAuthorization', {
      token,
      params: { marketplace: 'ebay' },
    });
    expect(started.status).toBe(201);
    const url = started.body.authorizationUrl ?? '';
    states.push(new URL(url).searchParams.get('state') ?? '');
    return started.body;
  }

  /** What the browser does after the consent page: follow eBay's redirect to the callback. */
  async function followRedirect(redirect: string) {
    const url = new URL(redirect);
    const response = await api.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers['cache-control']).toBe('no-store');
    return new URL(String(response.headers.location));
  }

  it('lists every marketplace: eBay to connect, the others assisted', async () => {
    const token = await api.signIn('list@example.com');
    const listed = await api.call('listConnections', { token });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((connection) => connection.marketplace)).toEqual([
      'ebay',
      'depop',
      'poshmark',
      'mercari',
    ]);
    const [ebay, ...assisted] = listed.body.data;
    expect(ebay).toMatchObject({
      mode: 'api',
      status: 'not_connected',
      statusDisplay: { tone: 'neutral', label: 'Not connected' },
      availableActions: ['connect'],
      capabilities: { connect: 'oauth' },
    });
    for (const connection of assisted) {
      expect(connection).toMatchObject({
        mode: 'assisted',
        status: 'not_connected',
        statusDisplay: { label: 'Not linked' },
        availableActions: [],
        capabilities: { connect: 'none', create: 'assisted', verifyRead: 'user_confirm' },
      });
    }
  });

  it('connects eBay end to end: consent, callback, and the attempt the app reads back', async () => {
    const token = await api.signIn('seller@example.com');
    const attempt = await start(token);
    expect(attempt).toMatchObject({
      marketplace: 'ebay',
      status: 'pending',
      callbackUrlScheme: 'listora',
    });
    const consent = new URL(attempt.authorizationUrl ?? '');
    expect(`${consent.origin}${consent.pathname}`).toBe(`${fake.url}/oauth2/authorize`);
    expect(consent.searchParams.get('redirect_uri')).toBe(FAKE_EBAY_RU_NAME);

    const appUrl = await followRedirect(fake.consent(consent.toString()));
    expect(appUrl.protocol).toBe('listora:');
    expect(appUrl.host).toBe('connections');
    expect(appUrl.pathname).toBe('/ebay');
    expect(appUrl.searchParams.get('authorizationId')).toBe(attempt.id);

    const result = await api.call('getConnectionAuthorization', {
      token,
      params: { marketplace: 'ebay', authorizationId: attempt.id },
    });
    expect(result.body).toMatchObject({
      id: attempt.id,
      status: 'completed',
      connection: {
        marketplace: 'ebay',
        status: 'connected',
        statusDisplay: {
          tone: 'success',
          label: 'Connected',
          detail: 'Signed in as listora_dev_seller.',
        },
        displayName: 'listora_dev_seller',
        availableActions: [],
      },
    });
    // The consent URL (with its state) is never handed out again.
    expect(result.body).not.toHaveProperty('authorizationUrl');
    const connection = await api.call('getConnection', { token, params: { marketplace: 'ebay' } });
    expect(connection.body).toMatchObject({ status: 'connected', mode: 'api' });
    expect(connection.body.grantExpiresAt).toBeDefined();

    // The API stored only ciphertext, which only the worker's vault opens.
    const tenant = await api.tenantOf('seller@example.com');
    const row = await api.db
      .selectFrom('marketplace_connection')
      .selectAll()
      .where('account_id', '=', tenant.accountId)
      .executeTakeFirstOrThrow();
    const sealed = row.token_ciphertext ?? Buffer.alloc(0);
    for (const secret of fake.issuedSecrets()) {
      expect(sealed.toString('latin1')).not.toContain(secret);
    }
    const tokens = await vault.open(sealed, { marketplace: 'ebay', connectionId: row.id });
    expect(fake.issuedSecrets()).toContain(tokens.refreshToken);
  });

  it('shows a declined consent as a failed attempt with the reason', async () => {
    const token = await api.signIn('decliner@example.com');
    const attempt = await start(token);
    const appUrl = await followRedirect(fake.consent(attempt.authorizationUrl ?? '', 'decline'));
    expect(appUrl.searchParams.get('authorizationId')).toBe(attempt.id);
    const result = await api.call('getConnectionAuthorization', {
      token,
      params: { marketplace: 'ebay', authorizationId: attempt.id },
    });
    expect(result.body).toMatchObject({
      status: 'failed',
      failure: {
        code: 'marketplace_authorization_denied',
        message: "You didn't allow Listora to use your eBay account, so nothing changed.",
        retryable: true,
      },
    });
    const listed = await api.call('listConnections', { token });
    expect(listed.body.data[0]).toMatchObject({ status: 'not_connected' });
  });

  it('redirects to the app even when the callback names no attempt', async () => {
    const token = await api.signIn('nostate@example.com');
    const attempt = await start(token);
    for (const query of ['?error=access_denied', '?state=forged&code=abc', '?state=']) {
      const appUrl = await followRedirect(`http://localhost/v1/connections/ebay/callback${query}`);
      expect(appUrl.toString()).toBe('listora://connections/ebay');
    }
    // The attempt the app started is untouched; the app shows it did not finish.
    const result = await api.call('getConnectionAuthorization', {
      token,
      params: { marketplace: 'ebay', authorizationId: attempt.id },
    });
    expect(result.body.status).toBe('pending');
    const unknown = await api.app.inject({
      method: 'GET',
      url: '/v1/connections/etsy/callback?state=x',
    });
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers.location).toBe('listora://connections/unknown');
  });

  it("keeps each account's attempts to itself", async () => {
    const owner = await api.signIn('owner-a@example.com');
    const other = await api.signIn('owner-b@example.com');
    const attempt = await start(owner);
    const read = await api.call('getConnectionAuthorization', {
      token: other,
      params: { marketplace: 'ebay', authorizationId: attempt.id },
    });
    expect(read.status).toBe(404);
  });

  /** Signs in and connects eBay end to end; returns the token and the connection's id. */
  async function connectedAccount(email: string) {
    const token = await api.signIn(email);
    const attempt = await start(token);
    await followRedirect(fake.consent(attempt.authorizationUrl ?? ''));
    const tenant = await api.tenantOf(email);
    const row = await api.db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', tenant.accountId)
      .executeTakeFirstOrThrow();
    return { token, connectionId: row.id };
  }

  async function setConnection(
    connectionId: string,
    values: { status: 'degraded' | 'reauth_required'; code: string; message: string },
  ) {
    await api.db
      .updateTable('marketplace_connection')
      .set({
        status: values.status,
        last_error: values.message,
        last_error_code: values.code,
        last_error_at: new Date(),
      })
      .where('id', '=', connectionId)
      .execute();
  }

  it('unlinks eBay: the connection and its data go at once, and the worker revokes the grant', async () => {
    const { token, connectionId } = await connectedAccount('unlink@example.com');
    const unlinked = await api.call('disconnectConnection', {
      token,
      params: { marketplace: 'ebay' },
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({
      marketplace: 'ebay',
      status: 'not_connected',
      availableActions: ['connect'],
    });
    expect(unlinked.body).not.toHaveProperty('displayName');
    expect(
      (await api.call('getConnection', { token, params: { marketplace: 'ebay' } })).body,
    ).toMatchObject({ status: 'not_connected' });
    const rows = await api.db
      .selectFrom('marketplace_connection')
      .select('id')
      .where('id', '=', connectionId)
      .execute();
    expect(rows).toEqual([]);
    // The sealed grant waits in the tombstone, for the worker's revocation only.
    const tombstone = await api.db
      .selectFrom('connection_deletion')
      .select(['reason', 'revocation'])
      .where('connection_id', '=', connectionId)
      .executeTakeFirstOrThrow();
    expect(tombstone).toEqual({ reason: 'unlinked', revocation: 'pending' });

    const again = await api.call('disconnectConnection', {
      token,
      params: { marketplace: 'ebay' },
    });
    expect(again.status).toBe(404);
    expect(again.error.code).toBe('not_found');
  });

  describe('connection health', () => {
    it('summarizes an account with nothing connected: no attention, email forwarding needs a domain', async () => {
      const token = await api.signIn('health-none@example.com');
      const health = await api.call('getConnectionHealth', { token });
      expect(health.status).toBe(200);
      expect(health.body).toEqual({
        needsAttention: false,
        attention: [],
        connections: (await api.call('listConnections', { token })).body.data,
        saleForwarding: {
          status: 'needs_domain',
          statusDisplay: {
            tone: 'neutral',
            label: 'Set up when you add a domain',
            detail:
              "Forwarding your marketplaces' sale emails to Listora lets it spot sales sooner. It needs Listora's email domain, which isn't set up yet.",
          },
        },
      });
      expect(health.body.connections.map((connection) => connection.statusDisplay.label)).toEqual([
        'Not connected',
        'Not linked',
        'Not linked',
        'Not linked',
      ]);
    });

    it('raises the banner while a connection needs the seller, with what to do', async () => {
      const { token, connectionId } = await connectedAccount('health-broken@example.com');
      const healthy = await api.call('getConnectionHealth', { token });
      expect(healthy.body).toMatchObject({ needsAttention: false, attention: [] });
      expect(healthy.body.connections[0]).toMatchObject({
        status: 'connected',
        statusDisplay: { label: 'Connected' },
      });
      expect(healthy.body.connections[0]?.lastOkAt).toBeDefined();

      await setConnection(connectionId, {
        status: 'reauth_required',
        code: 'grant_revoked',
        message: 'eBay no longer accepts Listora. Reconnect eBay.',
      });
      const broken = await api.call('getConnectionHealth', { token });
      expect(broken.body).toMatchObject({
        needsAttention: true,
        banner: {
          tone: 'action_needed',
          label: 'Reconnect eBay',
          detail: 'eBay no longer accepts Listora. Reconnect eBay.',
        },
        attention: [
          {
            marketplace: 'ebay',
            reason: 'reconnect',
            statusDisplay: { label: 'Reconnect needed' },
          },
        ],
      });
      expect(broken.body.connections[0]).toMatchObject({
        status: 'reauth_required',
        availableActions: ['reconnect'],
      });
    });

    it('Retry check: queues the worker check and answers Checking; refuses what a check cannot fix', async () => {
      const { token, connectionId } = await connectedAccount('health-retry@example.com');
      await setConnection(connectionId, {
        status: 'degraded',
        code: 'marketplace_error',
        message: 'eBay had a problem.',
      });
      const before = await api.call('getConnection', { token, params: { marketplace: 'ebay' } });
      expect(before.body).toMatchObject({
        statusDisplay: { label: 'Connection problem' },
        availableActions: ['check', 'reconnect'],
      });

      const checked = await api.call('requestConnectionCheck', {
        token,
        params: { marketplace: 'ebay' },
      });
      expect(checked.status).toBe(202);
      expect(checked.body).toMatchObject({
        status: 'degraded',
        statusDisplay: { tone: 'checking', label: 'Checking...' },
        availableActions: [],
      });
      const jobs = (
        await sql<{ key: string; payload: unknown }>`
          select job.key, job.payload from graphile_worker._private_jobs as job
          join graphile_worker._private_tasks as t on t.id = job.task_id
          where t.identifier = 'connection_health_check'
        `.execute(api.db)
      ).rows;
      expect(jobs).toContainEqual({
        key: `connection_check:${connectionId}`,
        payload: { connectionId },
      });
      const summary = await api.call('getConnectionHealth', { token });
      expect(summary.body.connections[0]?.statusDisplay.label).toBe('Checking...');

      await setConnection(connectionId, {
        status: 'reauth_required',
        code: 'grant_revoked',
        message: 'Reconnect eBay.',
      });
      const refused = await api.call('requestConnectionCheck', {
        token,
        params: { marketplace: 'ebay' },
      });
      expect(refused.status).toBe(409);
      expect(refused.error).toMatchObject({
        code: 'invalid_state_transition',
        message: "Listora can't check this eBay connection. Reconnect eBay.",
      });

      const other = await api.signIn('health-nothing@example.com');
      const nothing = await api.call('requestConnectionCheck', {
        token: other,
        params: { marketplace: 'ebay' },
      });
      expect(nothing.status).toBe(409);
      expect(nothing.error.message).toBe('Connect eBay first.');
    });
  });

  it('refuses to start a connection for a marketplace that has no OAuth connection', async () => {
    const token = await api.signIn('poshmark@example.com');
    const started = await api.call('startConnectionAuthorization', {
      token,
      params: { marketplace: 'poshmark' },
    });
    expect(started.status).toBe(409);
    expect(started.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message:
        'Poshmark has no account connection in Listora yet; Listora works with Poshmark in assisted mode.',
    });
  });
});

describe('marketplace connections API without eBay or a token vault', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createTestApi('connections_off');
  });

  afterAll(async () => {
    await api.close();
  });

  it('shows eBay as coming soon and refuses to connect it', async () => {
    const token = await api.signIn('off@example.com');
    const listed = await api.call('listConnections', { token });
    expect(listed.body.data[0]).toMatchObject({
      marketplace: 'ebay',
      mode: 'api',
      status: 'not_connected',
      statusDisplay: { label: 'Coming soon' },
      availableActions: [],
      capabilities: { connect: 'none', create: 'none' },
    });
    const started = await api.call('startConnectionAuthorization', {
      token,
      params: { marketplace: 'ebay' },
    });
    expect(started.status).toBe(409);
    expect(started.error.message).toBe("Listora can't connect eBay accounts yet.");
    const checked = await api.call('requestConnectionCheck', {
      token,
      params: { marketplace: 'ebay' },
    });
    expect(checked.status).toBe(409);
    expect(checked.error).toMatchObject({
      code: 'marketplace_action_unavailable',
      message: "Listora can't check eBay connections yet.",
    });
  });
});
