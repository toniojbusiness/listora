import { describe, expect, it } from 'vitest';

import { EbayConfigError, loadEbayConfig } from './config.ts';
import { FAKE_EBAY_CLIENT_ID, FAKE_EBAY_REFRESH_TOKEN } from './fake/constants.ts';

const issuesOf = (env: NodeJS.ProcessEnv): readonly string[] => {
  try {
    loadEbayConfig(env);
  } catch (error) {
    if (error instanceof EbayConfigError) return error.issues;
    throw error;
  }
  return [];
};

describe('loadEbayConfig', () => {
  it('leaves eBay unconfigured without EBAY_ENV', () => {
    expect(loadEbayConfig({})).toBeUndefined();
    expect(loadEbayConfig({ EBAY_ENV: '' })).toBeUndefined();
  });

  it("uses the fake's keys, and its development seller for the bound connection, in fake mode", () => {
    const config = loadEbayConfig({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: 'http://127.0.0.1:4555',
      EBAY_USER_CONNECTION_ID: 'connection-1',
    });
    expect(config).toMatchObject({
      environment: 'fake',
      clientId: FAKE_EBAY_CLIENT_ID,
      seller: { refreshToken: FAKE_EBAY_REFRESH_TOKEN, connectionId: 'connection-1' },
      tradingDailyLimit: 5_000,
      listingSettings: { postalCode: '95125', dispatchTimeMax: 3, policies: null },
    });
    expect(config?.endpoints).toEqual({
      trading: 'http://127.0.0.1:4555/ws/api.dll',
      api: 'http://127.0.0.1:4555',
      media: 'http://127.0.0.1:4555',
      oauthToken: 'http://127.0.0.1:4555/identity/v1/oauth2/token',
      authorize: 'http://127.0.0.1:4555/oauth2/authorize',
      oauthRevoke: 'http://127.0.0.1:4555/identity/v1/oauth2/token/revoke',
      identity: 'http://127.0.0.1:4555/commerce/identity/v1/user',
    });
    expect(config?.ruName).toBe('Listora-Fake-RuName');
  });

  it('configures no seller without a connection to bind it to', () => {
    expect(loadEbayConfig({ EBAY_ENV: 'fake' })?.seller).toBeUndefined();
    expect(issuesOf({ EBAY_ENV: 'fake', EBAY_USER_REFRESH_TOKEN: 'v^1.1#secret-refresh' })).toEqual(
      ['EBAY_USER_CONNECTION_ID is required with EBAY_USER_REFRESH_TOKEN'],
    );
    const keys = { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' };
    expect(
      issuesOf({ EBAY_ENV: 'sandbox', ...keys, EBAY_USER_CONNECTION_ID: 'connection-1' }),
    ).toEqual(['EBAY_USER_CONNECTION_ID needs EBAY_USER_REFRESH_TOKEN when EBAY_ENV is sandbox']);
    expect(
      loadEbayConfig({
        EBAY_ENV: 'sandbox',
        ...keys,
        EBAY_USER_REFRESH_TOKEN: 'v^1.1#refresh',
        EBAY_USER_CONNECTION_ID: 'connection-1',
      })?.seller,
    ).toEqual({ refreshToken: 'v^1.1#refresh', connectionId: 'connection-1' });
  });

  it('refuses a configured seller in production, naming the key but never its value', () => {
    const issues = issuesOf({
      EBAY_ENV: 'production',
      EBAY_CLIENT_ID: 'id',
      EBAY_CLIENT_SECRET: 'secret',
      EBAY_USER_REFRESH_TOKEN: 'v^1.1#secret-refresh',
      EBAY_USER_CONNECTION_ID: 'connection-1',
    });
    expect(issues).toEqual([
      'EBAY_USER_REFRESH_TOKEN is not allowed when EBAY_ENV is production (each eBay connection has its own token)',
      'EBAY_USER_CONNECTION_ID is not allowed when EBAY_ENV is production (each eBay connection has its own token)',
    ]);
    expect(issues.join(' ')).not.toContain('secret-refresh');
    expect(
      issuesOf({
        EBAY_ENV: 'production',
        EBAY_CLIENT_ID: 'id',
        EBAY_CLIENT_SECRET: 'secret',
        EBAY_USER_REFRESH_TOKEN: 'v^1.1#secret-refresh',
      }),
    ).toHaveLength(1);
  });

  it("uses eBay's hosts and needs the application keys in sandbox and production", () => {
    expect(issuesOf({ EBAY_ENV: 'sandbox' })).toEqual([
      'EBAY_CLIENT_ID is required when EBAY_ENV is sandbox',
      'EBAY_CLIENT_SECRET is required when EBAY_ENV is sandbox',
    ]);
    const keys = { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' };
    const sandbox = loadEbayConfig({ EBAY_ENV: 'sandbox', ...keys });
    expect(sandbox?.endpoints.trading).toBe('https://api.sandbox.ebay.com/ws/api.dll');
    expect(sandbox?.endpoints.media).toBe('https://apim.sandbox.ebay.com');
    // Without a seller's refresh token, nothing is listed (eBay operations ask to connect).
    expect(sandbox?.seller).toBeUndefined();
    const production = loadEbayConfig({
      EBAY_ENV: 'production',
      ...keys,
      EBAY_FULFILLMENT_POLICY_ID: '111',
      EBAY_PAYMENT_POLICY_ID: '222',
      EBAY_RETURN_POLICY_ID: '333',
    });
    expect(production?.endpoints.trading).toBe('https://api.ebay.com/ws/api.dll');
    expect(production?.endpoints.identity).toBe('https://apiz.ebay.com/commerce/identity/v1/user');
    expect(production?.endpoints.oauthRevoke).toBe(
      'https://api.ebay.com/identity/v1/oauth2/token/revoke',
    );
    // Without a RuName, sellers cannot connect; listing for a configured seller still works.
    expect(production?.ruName).toBeUndefined();
    expect(loadEbayConfig({ EBAY_ENV: 'production', ...keys, EBAY_RUNAME: 'ru' })?.ruName).toBe(
      'ru',
    );
    expect(production?.seller).toBeUndefined();
    expect(production?.listingSettings.policies).toEqual({
      fulfillmentPolicyId: '111',
      paymentPolicyId: '222',
      returnPolicyId: '333',
    });
  });

  it('names every bad key without echoing its value', () => {
    expect(issuesOf({ EBAY_ENV: 'staging' })).toEqual([
      'EBAY_ENV must be one of fake, sandbox, production',
    ]);
    const issues = issuesOf({
      EBAY_ENV: 'fake',
      EBAY_FAKE_URL: 'https://api.ebay.com/secret-value',
      EBAY_ITEM_POSTAL_CODE: 'not-a-zip',
      EBAY_DISPATCH_DAYS: '9',
      EBAY_PAYMENT_POLICY_ID: '123',
      EBAY_TRADING_DAILY_CALL_LIMIT: 'lots',
    });
    expect(issues).toEqual([
      'EBAY_FAKE_URL must be an http://127.0.0.1:<port> URL',
      'EBAY_ITEM_POSTAL_CODE must be a US ZIP code',
      'EBAY_DISPATCH_DAYS must be 0, 1, 2, or 3',
      'EBAY_FULFILLMENT_POLICY_ID, EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID must be set together, or not at all',
      'EBAY_TRADING_DAILY_CALL_LIMIT must be an integer from 100 to 10000000',
    ]);
    expect(issues.join(' ')).not.toContain('secret-value');
  });

  it('reads the notification endpoint, its verification token, and the alert email', () => {
    const token = 'listora-verification-token-0123456789abcdef';
    expect(loadEbayConfig({ EBAY_ENV: 'fake' })?.notifications).toBeUndefined();
    expect(
      loadEbayConfig({
        EBAY_ENV: 'fake',
        EBAY_NOTIFICATION_ENDPOINT: 'http://127.0.0.1:3000/webhooks/ebay',
        EBAY_NOTIFICATION_VERIFICATION_TOKEN: token,
      })?.notifications,
    ).toEqual({
      endpoint: 'http://127.0.0.1:3000/webhooks/ebay',
      verificationToken: token,
      alertEmail: null,
    });
    const production = {
      EBAY_ENV: 'production',
      EBAY_CLIENT_ID: 'id',
      EBAY_CLIENT_SECRET: 'secret',
      EBAY_NOTIFICATION_VERIFICATION_TOKEN: token,
    };
    expect(
      loadEbayConfig({
        ...production,
        EBAY_NOTIFICATION_ENDPOINT: 'https://api.listora.app/webhooks/ebay',
        EBAY_NOTIFICATION_ALERT_EMAIL: 'ops@listora.app',
      })?.notifications,
    ).toMatchObject({ alertEmail: 'ops@listora.app' });
    expect(
      issuesOf({
        ...production,
        EBAY_NOTIFICATION_ENDPOINT: 'http://localhost:3000/webhooks/ebay',
        EBAY_NOTIFICATION_VERIFICATION_TOKEN: 'short-secret-value',
        EBAY_NOTIFICATION_ALERT_EMAIL: 'nope',
      }),
    ).toEqual([
      'EBAY_NOTIFICATION_ENDPOINT must be a public https URL without a query',
      'EBAY_NOTIFICATION_VERIFICATION_TOKEN must be 32 to 80 letters, digits, underscores, or hyphens',
      'EBAY_NOTIFICATION_ALERT_EMAIL must be an email address',
    ]);
    expect(issuesOf({ EBAY_ENV: 'fake', EBAY_NOTIFICATION_VERIFICATION_TOKEN: token })).toEqual([
      'EBAY_NOTIFICATION_VERIFICATION_TOKEN needs EBAY_NOTIFICATION_ENDPOINT',
    ]);
  });
});
