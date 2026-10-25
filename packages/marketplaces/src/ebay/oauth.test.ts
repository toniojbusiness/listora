import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FAKE_EBAY_CLIENT_ID,
  FAKE_EBAY_CLIENT_SECRET,
  FAKE_EBAY_REFRESH_TOKEN,
} from './fake/constants.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import {
  ApplicationToken,
  EbayOAuthClient,
  EbayReauthRequiredError,
  EbayTokenUnavailableError,
  RefreshTokenSeller,
} from './oauth.ts';

const signal = new AbortController().signal;

describe('eBay OAuth against the fake eBay', () => {
  let fake: FakeEbay;
  let oauth: EbayOAuthClient;

  beforeAll(async () => {
    fake = await FakeEbay.start();
    oauth = new EbayOAuthClient({
      tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: FAKE_EBAY_CLIENT_SECRET,
      timeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  const tokenRequests = () => fake.requests.filter((request) => request.action === 'token').length;

  it('exchanges a refresh token for a two-hour user access token', async () => {
    const before = Date.now();
    const token = await oauth.refreshUserToken(
      FAKE_EBAY_REFRESH_TOKEN,
      ['https://api.ebay.com/oauth/api_scope'],
      signal,
    );
    expect(token.token).toMatch(/^v\^1\.1#/);
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 7_200_000);
  });

  it('asks the seller to reconnect when the grant is revoked, and never puts tokens in errors', async () => {
    const { refreshToken } = fake.addSeller();
    fake.revokeSeller(refreshToken);
    const failure = oauth.refreshUserToken(refreshToken, [], signal);
    await expect(failure).rejects.toBeInstanceOf(EbayReauthRequiredError);
    await expect(failure).rejects.not.toThrow(refreshToken);
  });

  it('refuses wrong application keys as a reconnect, not a retry', async () => {
    const wrong = new EbayOAuthClient({
      tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: 'wrong',
    });
    await expect(wrong.applicationToken([], signal)).rejects.toThrow(
      'eBay application keys were refused',
    );
  });

  it('reports an unreachable token endpoint as unavailable', async () => {
    const closed = await FakeEbay.start();
    const url = closed.url;
    await closed.close();
    const offline = new EbayOAuthClient({
      tokenUrl: `${url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: FAKE_EBAY_CLIENT_SECRET,
    });
    await expect(offline.applicationToken([], signal)).rejects.toBeInstanceOf(
      EbayTokenUnavailableError,
    );
    fake.inject({ action: 'token', fault: { type: 'server_error' } });
    await expect(oauth.applicationToken([], signal)).rejects.toThrow('(http_503)');
  });

  it('refreshes a seller token once for concurrent callers, and caches it until shortly before it expires', async () => {
    let now = Date.now();
    const seller = new RefreshTokenSeller({
      oauth,
      refreshToken: FAKE_EBAY_REFRESH_TOKEN,
      now: () => now,
    });
    const before = tokenRequests();
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => seller.accessToken(null, signal)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(tokenRequests() - before).toBe(1);

    now += 60 * 60_000;
    expect(await seller.accessToken(null, signal)).toBe(tokens[0]);
    expect(tokenRequests() - before).toBe(1);
    // Within five minutes of expiry, it refreshes.
    now += 56 * 60_000;
    expect(await seller.accessToken(null, signal)).not.toBe(tokens[0]);
    expect(tokenRequests() - before).toBe(2);
  });

  it('refreshes again after a token eBay refused is forgotten', async () => {
    const seller = new RefreshTokenSeller({ oauth, refreshToken: FAKE_EBAY_REFRESH_TOKEN });
    const first = await seller.accessToken(null, signal);
    seller.forget(null, 'some other token');
    expect(await seller.accessToken(null, signal)).toBe(first);
    seller.forget(null, first);
    expect(await seller.accessToken(null, signal)).not.toBe(first);
  });

  it('caches the application token', async () => {
    const application = new ApplicationToken(oauth);
    const before = tokenRequests();
    const [first, second] = await Promise.all([application.get(signal), application.get(signal)]);
    expect(first).toBe(second);
    expect(await application.get(signal)).toBe(first);
    expect(tokenRequests() - before).toBe(1);
  });
});
