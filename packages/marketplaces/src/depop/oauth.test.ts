/**
 * Connecting Depop (OAuth 2.0 authorization code with PKCE) and refreshing tokens, against the
 * fake Depop's consent page and token endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depopEndpoints } from './config.ts';
import { FAKE_DEPOP_CLIENT_ID, FAKE_DEPOP_CLIENT_SECRET } from './fake/constants.ts';
import { FakeDepop } from './fake/fake-depop.ts';
import {
  createPkcePair,
  DEPOP_GRANT_LIFETIME_MS,
  DepopOAuthClient,
  DepopReauthRequiredError,
  DepopTokenUnavailableError,
  pkceChallenge,
} from './oauth.ts';

const signal = new AbortController().signal;
const REDIRECT_URI = 'https://app.listora.test/connect/depop/callback';

describe('Depop OAuth against the fake Depop', () => {
  let fake: FakeDepop;
  let oauth: DepopOAuthClient;

  beforeAll(async () => {
    fake = await FakeDepop.start({ redirectUris: [REDIRECT_URI] });
    const endpoints = depopEndpoints('fake', fake.url);
    oauth = new DepopOAuthClient({
      tokenUrl: endpoints.oauthToken,
      authorizeUrl: endpoints.authorize,
      clientId: FAKE_DEPOP_CLIENT_ID,
      clientSecret: FAKE_DEPOP_CLIENT_SECRET,
      timeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    expect(fake.specViolations).toEqual([]);
    await fake.close();
  });

  /** The seller opens the consent URL and approves; returns the callback's query. */
  async function consent(url: string): Promise<URLSearchParams> {
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    return location.searchParams;
  }

  it('makes an S256 PKCE pair Depop accepts', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
    // Depop's own example pair ("Your first OAuth connection").
    expect(pkceChallenge('vvkdljkejllufrvbhgeiegrnvufrhvrffnkvcknjvfid')).toBe(
      'DSWlW2Abh-cf8CeLL8-g3hQ2WQyYdKyiu83u_s7nRhI',
    );
  });

  it('builds the consent URL Depop documents, scopes joined with +', () => {
    const url = new URL(
      oauth.authorizationUrl({ redirectUri: REDIRECT_URI, state: 'abc123xyz', codeChallenge: 'C' }),
    );
    expect(url.pathname).toBe('/settings/oauth/apps/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: FAKE_DEPOP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: 'abc123xyz',
      scope: 'products_read+products_write+orders_read+shop_read',
      code_challenge: 'C',
      code_challenge_method: 'S256',
    });
    expect(url.search).toContain('scope=products_read%2Bproducts_write');
  });

  it('connects a seller: consent, the callback code, and the PKCE exchange for a year-long grant', async () => {
    const pair = createPkcePair();
    const query = await consent(
      oauth.authorizationUrl({
        redirectUri: REDIRECT_URI,
        state: 'state-1',
        codeChallenge: pair.challenge,
      }),
    );
    expect(query.get('state')).toBe('state-1');
    const code = query.get('code') ?? '';
    const before = Date.now();
    const tokens = await oauth.exchangeAuthorizationCode(
      { code, redirectUri: REDIRECT_URI, codeVerifier: pair.verifier },
      signal,
    );
    expect(tokens.accessToken).toMatch(/^pat_/);
    expect(tokens.refreshToken).toMatch(/^prt_/);
    expect(tokens.accessExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(tokens.grantExpiresAt).toBeGreaterThanOrEqual(before + DEPOP_GRANT_LIFETIME_MS);
    // The code is single-use.
    await expect(
      oauth.exchangeAuthorizationCode(
        { code, redirectUri: REDIRECT_URI, codeVerifier: pair.verifier },
        signal,
      ),
    ).rejects.toBeInstanceOf(DepopReauthRequiredError);
  });

  it('refuses a code exchanged with the wrong verifier or redirect URI', async () => {
    const pair = createPkcePair();
    const start = () =>
      consent(
        oauth.authorizationUrl({
          redirectUri: REDIRECT_URI,
          state: 's',
          codeChallenge: pair.challenge,
        }),
      );
    const first = (await start()).get('code') ?? '';
    await expect(
      oauth.exchangeAuthorizationCode(
        { code: first, redirectUri: REDIRECT_URI, codeVerifier: createPkcePair().verifier },
        signal,
      ),
    ).rejects.toBeInstanceOf(DepopReauthRequiredError);
    const second = (await start()).get('code') ?? '';
    await expect(
      oauth.exchangeAuthorizationCode(
        { code: second, redirectUri: 'https://elsewhere.test/cb', codeVerifier: pair.verifier },
        signal,
      ),
    ).rejects.toBeInstanceOf(DepopReauthRequiredError);
  });

  it('reports a denied consent on the callback, and refuses unregistered redirect URIs', async () => {
    fake.denyNextConsent();
    const query = await consent(
      oauth.authorizationUrl({ redirectUri: REDIRECT_URI, state: 'denied', codeChallenge: 'x' }),
    );
    expect(query.get('error')).toBe('access_denied');
    expect(query.get('state')).toBe('denied');
    expect(query.has('code')).toBe(false);
    const unregistered = await fetch(
      oauth.authorizationUrl({
        redirectUri: 'https://evil.test/cb',
        state: 's',
        codeChallenge: 'x',
      }),
      { redirect: 'manual' },
    );
    expect(unregistered.status).toBe(400);
  });

  it('rotates refresh tokens: the old refresh and access tokens stop working', async () => {
    const { refreshToken } = fake.addSeller();
    const seed = {
      accessToken: '',
      accessExpiresAt: 0,
      refreshToken,
      grantExpiresAt: Date.now() + 60_000,
    };
    const first = await oauth.refresh(seed, signal);
    expect(first.refreshToken).not.toBe(refreshToken);
    expect(first.grantExpiresAt).toBe(seed.grantExpiresAt);
    const shop = (token: string) =>
      fetch(`${fake.url}/api/v1/shop/`, { headers: { authorization: `Bearer ${token}` } });
    expect((await shop(first.accessToken)).status).toBe(200);
    const second = await oauth.refresh(first, signal);
    expect((await shop(first.accessToken)).status).toBe(401);
    expect((await shop(second.accessToken)).status).toBe(200);
    const reused = oauth.refresh(first, signal);
    await expect(reused).rejects.toBeInstanceOf(DepopReauthRequiredError);
    await expect(reused).rejects.not.toThrow(first.refreshToken);
  });

  it('refuses to refresh past the end of the grant, without asking Depop', async () => {
    const before = fake.tokenRequests;
    await expect(
      oauth.refresh(
        {
          accessToken: '',
          accessExpiresAt: 0,
          refreshToken: 'prt_x',
          grantExpiresAt: Date.now() - 1,
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(DepopReauthRequiredError);
    expect(fake.tokenRequests).toBe(before);
  });

  it('treats wrong application keys as a reconnect and an unreachable endpoint as unavailable', async () => {
    const endpoints = depopEndpoints('fake', fake.url);
    const wrong = new DepopOAuthClient({
      tokenUrl: endpoints.oauthToken,
      authorizeUrl: endpoints.authorize,
      clientId: FAKE_DEPOP_CLIENT_ID,
      clientSecret: 'wrong',
    });
    const { refreshToken } = fake.addSeller();
    const seed = {
      accessToken: '',
      accessExpiresAt: 0,
      refreshToken,
      grantExpiresAt: Date.now() + 60_000,
    };
    await expect(wrong.refresh(seed, signal)).rejects.toThrow('application keys were refused');

    const closed = await FakeDepop.start();
    const url = closed.url;
    await closed.close();
    const offline = new DepopOAuthClient({
      tokenUrl: depopEndpoints('fake', url).oauthToken,
      authorizeUrl: endpoints.authorize,
      clientId: FAKE_DEPOP_CLIENT_ID,
      clientSecret: FAKE_DEPOP_CLIENT_SECRET,
    });
    await expect(offline.refresh(seed, signal)).rejects.toBeInstanceOf(DepopTokenUnavailableError);

    fake.inject({ action: 'token', fault: { type: 'server_error' } });
    await expect(oauth.refresh(seed, signal)).rejects.toThrow('http_503');
  });
});
