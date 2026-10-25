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

  it("uses the fake's keys and development seller in fake mode", () => {
    const config = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_FAKE_URL: 'http://127.0.0.1:4555' });
    expect(config).toMatchObject({
      environment: 'fake',
      clientId: FAKE_EBAY_CLIENT_ID,
      userRefreshToken: FAKE_EBAY_REFRESH_TOKEN,
      tradingDailyLimit: 5_000,
      listingSettings: { postalCode: '95125', dispatchTimeMax: 3, policies: null },
    });
    expect(config?.endpoints).toEqual({
      trading: 'http://127.0.0.1:4555/ws/api.dll',
      api: 'http://127.0.0.1:4555',
      media: 'http://127.0.0.1:4555',
      oauthToken: 'http://127.0.0.1:4555/identity/v1/oauth2/token',
      authorize: 'http://127.0.0.1:4555/oauth2/authorize',
    });
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
    expect(sandbox?.userRefreshToken).toBeUndefined();
    const production = loadEbayConfig({
      EBAY_ENV: 'production',
      ...keys,
      EBAY_USER_REFRESH_TOKEN: 'v^1.1#refresh',
      EBAY_FULFILLMENT_POLICY_ID: '111',
      EBAY_PAYMENT_POLICY_ID: '222',
      EBAY_RETURN_POLICY_ID: '333',
    });
    expect(production?.endpoints.trading).toBe('https://api.ebay.com/ws/api.dll');
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
});
