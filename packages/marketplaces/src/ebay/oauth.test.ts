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
const connection = { id: 'connection-ebay', mode: 'api' } as const;

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
      connectionId: connection.id,
      now: () => now,
    });
    const before = tokenRequests();
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => seller.accessToken(connection, signal)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(tokenRequests() - before).toBe(1);

    now += 60 * 60_000;
    expect(await seller.accessToken(connection, signal)).toBe(tokens[0]);
    expect(tokenRequests() - before).toBe(1);
    // Within five minutes of expiry, it refreshes.
    now += 56 * 60_000;
    expect(await seller.accessToken(connection, signal)).not.toBe(tokens[0]);
    expect(tokenRequests() - before).toBe(2);
  });

  it('refreshes again after a token eBay refused is forgotten', async () => {
    const seller = new RefreshTokenSeller({
      oauth,
      refreshToken: FAKE_EBAY_REFRESH_TOKEN,
      connectionId: connection.id,
    });
    const first = await seller.accessToken(connection, signal);
    seller.forget(connection, 'some other token');
    expect(await seller.accessToken(connection, signal)).toBe(first);
    seller.forget(connection, first);
    expect(await seller.accessToken(connection, signal)).not.toBe(first);
  });

  it("acts only for the connection it is bound to, never another or a listing's missing one", async () => {
    const seller = new RefreshTokenSeller({
      oauth,
      refreshToken: FAKE_EBAY_REFRESH_TOKEN,
      connectionId: connection.id,
    });
    const before = tokenRequests();
    for (const other of [{ id: 'another-connection', mode: 'api' } as const, null]) {
      const refused = seller.accessToken(other, signal);
      await expect(refused).rejects.toBeInstanceOf(EbayReauthRequiredError);
      await expect(refused).rejects.toThrow('Connect eBay to list there.');
    }
    expect(tokenRequests() - before).toBe(0);
    await expect(seller.accessToken(connection, signal)).resolves.toMatch(/^v\^1\.1#/);
  });

  it("keeps a shared refresh going for the other callers when one caller's signal aborts", async () => {
    const seller = new RefreshTokenSeller({
      oauth,
      refreshToken: FAKE_EBAY_REFRESH_TOKEN,
      connectionId: connection.id,
    });
    const application = new ApplicationToken(oauth);
    fake.inject({ action: 'token', fault: { type: 'timeout_after_send', delayMs: 200 } });
    fake.inject({ action: 'token', fault: { type: 'timeout_after_send', delayMs: 200 } });
    const impatient = new AbortController();
    const first = seller.accessToken(connection, impatient.signal);
    const second = seller.accessToken(connection, signal);
    const firstApp = application.get(impatient.signal);
    const secondApp = application.get(signal);
    impatient.abort();
    await expect(first).rejects.toBeInstanceOf(EbayTokenUnavailableError);
    await expect(firstApp).rejects.toBeInstanceOf(EbayTokenUnavailableError);
    await expect(second).resolves.toMatch(/^v\^1\.1#/);
    await expect(secondApp).resolves.toEqual(expect.any(String));
    // The refresh finished for everyone: a later caller gets the cached token.
    expect(await seller.accessToken(connection, signal)).toBe(await second);
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
