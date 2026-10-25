import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_CLIENT_SECRET } from './fake/constants.ts';
import { FakeEbay } from './fake/fake-ebay.ts';
import {
  EBAY_USER_SCOPES,
  EbayOAuthClient,
  EbayReauthRequiredError,
  ebayConsentUrl,
} from './oauth.ts';
import { codeFromRedirect, withEnvValue } from './sandbox-token.ts';

describe('getting a sandbox refresh token', () => {
  let fake: FakeEbay;

  beforeAll(async () => {
    fake = await FakeEbay.start();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("builds eBay's consent URL with the RuName, scopes, and state", () => {
    const url = new URL(
      ebayConsentUrl({
        authorizeUrl: 'https://auth.sandbox.ebay.com/oauth2/authorize',
        clientId: 'client-id',
        ruName: 'Listora-Listora-SBX-abc',
        scopes: EBAY_USER_SCOPES,
        state: 'state-1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.sandbox.ebay.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      redirect_uri: 'Listora-Listora-SBX-abc',
      response_type: 'code',
      scope: EBAY_USER_SCOPES.join(' '),
      state: 'state-1',
    });
  });

  it('reads the code from the accept page address, checking the state', () => {
    const address =
      'https://auth2.ebay.com/oauth2/ThirdPartyAuthSucessFailure?isAuthSuccessful=true&state=s1&code=v%5E1.1%23i%5E1&expires_in=299';
    expect(codeFromRedirect(address, 's1')).toBe('v^1.1#i^1');
    expect(() => codeFromRedirect(address, 'other')).toThrow('another sign-in');
    expect(() => codeFromRedirect('https://auth2.ebay.com/?state=s1', 's1')).toThrow('no code');
    expect(() => codeFromRedirect('not a url', 's1')).toThrow('not a URL');
  });

  it('exchanges the code once for a refresh token that works', async () => {
    const oauth = new EbayOAuthClient({
      tokenUrl: `${fake.url}/identity/v1/oauth2/token`,
      clientId: FAKE_EBAY_CLIENT_ID,
      clientSecret: FAKE_EBAY_CLIENT_SECRET,
    });
    const code = fake.authorizationCode();
    const signal = new AbortController().signal;
    const tokens = await oauth.exchangeAuthorizationCode(code, 'Listora-RuName', signal);
    expect(tokens.refreshExpiresAt - Date.now()).toBeGreaterThan(47_000_000_000);
    await expect(oauth.refreshUserToken(tokens.refreshToken, [], signal)).resolves.toMatchObject({
      token: expect.any(String) as string,
    });
    await expect(
      oauth.exchangeAuthorizationCode(code, 'Listora-RuName', signal),
    ).rejects.toBeInstanceOf(EbayReauthRequiredError);
  });

  it('saves the token in .env, replacing an earlier one', () => {
    expect(withEnvValue('', 'EBAY_USER_REFRESH_TOKEN', 'v1')).toBe('EBAY_USER_REFRESH_TOKEN=v1\n');
    expect(withEnvValue('A=1', 'EBAY_USER_REFRESH_TOKEN', 'v1')).toBe(
      'A=1\nEBAY_USER_REFRESH_TOKEN=v1\n',
    );
    expect(
      withEnvValue('A=1\n# EBAY_USER_REFRESH_TOKEN=\nB=2\n', 'EBAY_USER_REFRESH_TOKEN', 'v2'),
    ).toBe('A=1\nEBAY_USER_REFRESH_TOKEN=v2\nB=2\n');
  });
});
