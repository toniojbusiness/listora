import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEbayConfig } from './config.ts';
import { EbayConnectClient } from './connect.ts';
import { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_RU_NAME } from './fake/constants.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import { EBAY_USER_SCOPES } from './oauth.ts';

describe('EbayConnectClient against the fake eBay', () => {
  let fake: FakeEbay;
  let client: EbayConnectClient;
  const now = new Date('2026-10-24T12:00:00.000Z');
  const ctx = () => ({ signal: AbortSignal.timeout(5_000), now });

  beforeAll(async () => {
    fake = await FakeEbay.start({
      consentRedirect: { acceptUrl: 'https://api.listora.test/v1/connections/ebay/callback' },
    });
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: fake.url });
    const built = config === undefined ? undefined : EbayConnectClient.fromConfig(config);
    if (built === undefined) throw new Error('no connect client');
    client = built;
  });

  afterAll(async () => {
    await fake.close();
  });

  async function grant() {
    const redirect = new URL(fake.consent(client.authorizationUrl('state-1')));
    const exchanged = await client.exchangeCode(redirect.searchParams.get('code') ?? '', ctx());
    if (exchanged.type !== 'granted') throw new Error(`exchange failed: ${exchanged.type}`);
    return exchanged.grant;
  }

  it('has no client without a RuName: sellers cannot connect', () => {
    const config = loadEbayConfig({
      EBAY_ENV: 'production',
      EBAY_CLIENT_ID: 'id',
      EBAY_CLIENT_SECRET: 'secret',
    });
    expect(config && EbayConnectClient.fromConfig(config)).toBeUndefined();
  });

  it('builds the consent URL eBay documents', () => {
    const url = new URL(client.authorizationUrl('s+t/a=te'));
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: FAKE_EBAY_CLIENT_ID,
      redirect_uri: FAKE_EBAY_RU_NAME,
      response_type: 'code',
      scope: EBAY_USER_SCOPES.join(' '),
      state: 's+t/a=te',
    });
    expect(client.scopes).toContain(
      'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    );
  });

  it('exchanges the code from the accept redirect for tokens with their expiry', async () => {
    const redirect = new URL(fake.consent(client.authorizationUrl('abc')));
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      'https://api.listora.test/v1/connections/ebay/callback',
    );
    expect(redirect.searchParams.get('state')).toBe('abc');
    const exchanged = await client.exchangeCode(redirect.searchParams.get('code') ?? '', ctx());
    expect(exchanged).toMatchObject({
      type: 'granted',
      grant: {
        accessExpiresAt: new Date(now.getTime() + 7_200_000),
        refreshExpiresAt: new Date(now.getTime() + 47_304_000_000),
        scopes: [...EBAY_USER_SCOPES],
      },
    });
  });

  it('refuses a code used twice, as eBay does', async () => {
    const code = new URL(fake.consent(client.authorizationUrl('abc'))).searchParams.get('code');
    expect((await client.exchangeCode(code ?? '', ctx())).type).toBe('granted');
    expect(await client.exchangeCode(code ?? '', ctx())).toMatchObject({
      type: 'rejected',
      code: 'authorization_code_rejected',
    });
  });

  it('declines without a code', () => {
    const redirect = new URL(fake.consent(client.authorizationUrl('abc'), 'decline'));
    expect(redirect.searchParams.get('code')).toBeNull();
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('abc');
  });

  it('identifies the seller by the immutable user id', async () => {
    const { tokens } = await grant();
    expect(await client.identify(tokens.accessToken, ctx())).toEqual({
      type: 'identified',
      externalUserId: fake.signedInSeller.userId,
      displayName: 'listora_dev_seller',
    });
    expect(await client.identify('not-a-token', ctx())).toMatchObject({ type: 'unauthorized' });
  });

  it('refreshes the access token and keeps the refresh token', async () => {
    const { tokens } = await grant();
    const refreshed = await client.refresh(tokens.refreshToken, ctx());
    expect(refreshed).toMatchObject({ type: 'refreshed' });
    expect(refreshed).not.toHaveProperty('refreshToken');
    if (refreshed.type !== 'refreshed') return;
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    expect((await client.identify(refreshed.accessToken, ctx())).type).toBe('identified');
  });

  it('reports a revoked or expired refresh token as reauth_required', async () => {
    const { tokens } = await grant();
    fake.revokeSellerAccess(fake.signedInSeller.userId);
    expect(await client.refresh(tokens.refreshToken, ctx())).toMatchObject({
      type: 'reauth_required',
      code: 'grant_revoked',
    });
    expect((await client.identify(tokens.accessToken, ctx())).type).toBe('unauthorized');

    const second = await grant();
    fake.expireRefreshTokens();
    expect((await client.refresh(second.tokens.refreshToken, ctx())).type).toBe('reauth_required');
  });

  it('reports eBay outages and rate limits as unavailable, never as reauth', async () => {
    const { tokens } = await grant();
    fake.inject({ action: 'token', fault: { type: 'server_error', status: 503 } });
    expect(await client.refresh(tokens.refreshToken, ctx())).toMatchObject({
      type: 'unavailable',
      code: 'marketplace_error',
    });
    fake.inject({ action: 'token', fault: { type: 'rate_limited', retryAfterSeconds: 7 } });
    expect(await client.refresh(tokens.refreshToken, ctx())).toMatchObject({
      type: 'unavailable',
      code: 'rate_limited',
      retryAfterMs: 7_000,
    });
    fake.inject({ action: 'identity', fault: { type: 'server_error' } });
    expect((await client.identify(tokens.accessToken, ctx())).type).toBe('unavailable');
    fake.inject({ action: 'token', fault: { type: 'hang', afterApply: false } });
    expect(
      await client.refresh(tokens.refreshToken, { signal: AbortSignal.timeout(200), now }),
    ).toMatchObject({ type: 'unavailable' });
  });

  it("reports wrong app credentials as unavailable, not as the seller's problem", async () => {
    const { tokens } = await grant();
    const config = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: fake.url,
      EBAY_CLIENT_SECRET: 'wrong-secret',
    });
    const wrong = config === undefined ? undefined : EbayConnectClient.fromConfig(config);
    expect(await wrong?.refresh(tokens.refreshToken, ctx())).toMatchObject({
      type: 'unavailable',
      code: 'client_rejected',
    });
  });

  it('revokes the grant, and a repeated revocation still answers yes', async () => {
    const { tokens } = await grant();
    expect(await client.revoke(tokens, ctx())).toBe(true);
    expect((await client.refresh(tokens.refreshToken, ctx())).type).toBe('reauth_required');
    expect((await client.identify(tokens.accessToken, ctx())).type).toBe('unauthorized');
    expect(await client.revoke(tokens, ctx())).toBe(true);
    fake.inject({ action: 'revoke', fault: { type: 'server_error' } });
    expect(await client.revoke(tokens, ctx())).toBe(false);
  });

  it('serves the consent page over HTTP, and its decision redirects to the RuName URL', async () => {
    const page = await fetch(client.authorizationUrl('page-state'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Agree and Continue');
    const form = new URLSearchParams(new URL(client.authorizationUrl('page-state')).searchParams);
    form.set('decision', 'agree');
    const decided = await fetch(`${fake.url}/oauth2/authorize`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(decided.status).toBe(302);
    const location = new URL(decided.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe('page-state');
    expect(location.searchParams.get('code')).toMatch(/^v\^1\.1#/);
  });
});
