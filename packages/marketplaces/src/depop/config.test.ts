import { describe, expect, it } from 'vitest';

import { DepopConfigError, loadDepopConfig } from './config.ts';
import {
  FAKE_DEPOP_ADDRESS_ID,
  FAKE_DEPOP_CLIENT_ID,
  FAKE_DEPOP_REFRESH_TOKEN,
} from './fake/constants.ts';

const issuesOf = (env: NodeJS.ProcessEnv): readonly string[] => {
  try {
    loadDepopConfig(env);
  } catch (error) {
    if (error instanceof DepopConfigError) return error.issues;
    throw error;
  }
  return [];
};

const keys = { DEPOP_CLIENT_ID: 'client', DEPOP_CLIENT_SECRET: 'not-a-real-secret' };

describe('loadDepopConfig', () => {
  it('leaves Depop to assisted mode without DEPOP_ENV', () => {
    expect(loadDepopConfig({})).toBeUndefined();
    expect(loadDepopConfig({ DEPOP_ENV: '' })).toBeUndefined();
    expect(issuesOf({ DEPOP_ENV: 'staging' })).toEqual([
      'DEPOP_ENV must be one of fake, sandbox, production',
    ]);
  });

  it("uses the fake's client, development seller, and shop address in fake mode", () => {
    const config = loadDepopConfig({
      DEPOP_ENV: 'fake',
      DEPOP_FAKE_URL: 'http://127.0.0.1:4555',
      DEPOP_USER_CONNECTION_ID: 'connection-1',
    });
    expect(config).toMatchObject({
      environment: 'fake',
      clientId: FAKE_DEPOP_CLIENT_ID,
      seller: { refreshToken: FAKE_DEPOP_REFRESH_TOKEN, connectionId: 'connection-1' },
      listingSettings: {
        address: { countryCode: 'US', state: 'California' },
        shipping: {
          type: 'depop',
          addressId: FAKE_DEPOP_ADDRESS_ID,
          providerId: 'USPS',
          parcelSizeId: 'SMALL',
          payer: 'buyer',
        },
      },
      applicationRequestsPerMinute: 30_000,
    });
    expect(config?.endpoints).toEqual({
      api: 'http://127.0.0.1:4555',
      oauthToken: 'http://127.0.0.1:4555/api/v1/oauth2/access-token/',
      authorize: 'http://127.0.0.1:4555/settings/oauth/apps/',
    });
    expect(issuesOf({ DEPOP_ENV: 'fake', DEPOP_FAKE_URL: 'https://partnerapi.depop.com' })).toEqual(
      ['DEPOP_FAKE_URL must be an http://127.0.0.1:<port> URL'],
    );
  });

  it("uses Depop's hosts and needs real keys for the sandbox and production", () => {
    expect(issuesOf({ DEPOP_ENV: 'sandbox' })).toEqual([
      'DEPOP_CLIENT_ID is required when DEPOP_ENV is sandbox',
      'DEPOP_CLIENT_SECRET is required when DEPOP_ENV is sandbox',
    ]);
    expect(loadDepopConfig({ DEPOP_ENV: 'sandbox', ...keys })?.endpoints.api).toBe(
      'https://partnerapi-staging.depop.com',
    );
    expect(loadDepopConfig({ DEPOP_ENV: 'production', ...keys })).toMatchObject({
      endpoints: {
        api: 'https://partnerapi.depop.com',
        oauthToken: 'https://partnerapi.depop.com/api/v1/oauth2/access-token/',
        authorize: 'https://www.depop.com/settings/oauth/apps/',
      },
      seller: undefined,
      listingSettings: null,
    });
  });

  it('binds the one configured seller to its connection, and never in production', () => {
    expect(issuesOf({ DEPOP_ENV: 'fake', DEPOP_USER_REFRESH_TOKEN: 'prt_secret' })).toEqual([
      'DEPOP_USER_CONNECTION_ID is required with DEPOP_USER_REFRESH_TOKEN',
    ]);
    expect(
      issuesOf({
        DEPOP_ENV: 'sandbox',
        ...keys,
        DEPOP_USER_CONNECTION_ID: 'connection-1',
        DEPOP_SHIP_FROM_ADDRESS_ID: '123',
        DEPOP_PARCEL_SIZE_ID: 'SMALL',
      }),
    ).toEqual([
      'DEPOP_USER_CONNECTION_ID needs DEPOP_USER_REFRESH_TOKEN when DEPOP_ENV is sandbox',
    ]);
    const production = issuesOf({
      DEPOP_ENV: 'production',
      ...keys,
      DEPOP_USER_REFRESH_TOKEN: 'prt_secret-value',
      DEPOP_USER_CONNECTION_ID: 'connection-1',
    });
    expect(production).toEqual([
      'DEPOP_USER_REFRESH_TOKEN is not allowed when DEPOP_ENV is production (each Depop connection has its own token)',
      'DEPOP_USER_CONNECTION_ID is not allowed when DEPOP_ENV is production (each Depop connection has its own token)',
    ]);
    // Errors name keys, never their values.
    expect(production.join(' ')).not.toContain('prt_secret-value');
  });

  it("reads the seller's shipping: Depop Shipping from an address, or a national cost", () => {
    const sandbox = { DEPOP_ENV: 'sandbox', ...keys };
    expect(
      loadDepopConfig({
        ...sandbox,
        DEPOP_SHIP_FROM_ADDRESS_ID: '123456',
        DEPOP_PARCEL_SIZE_ID: 'MEDIUM',
        DEPOP_SHIPPING_PAYER: 'seller',
        DEPOP_ITEM_STATE: 'New York',
      })?.listingSettings,
    ).toEqual({
      address: { countryCode: 'US', state: 'New York' },
      shipping: {
        type: 'depop',
        addressId: 123456,
        providerId: 'USPS',
        parcelSizeId: 'MEDIUM',
        payer: 'seller',
      },
    });
    expect(
      loadDepopConfig({
        ...sandbox,
        DEPOP_ITEM_COUNTRY: 'GB',
        DEPOP_NATIONAL_SHIPPING_COST: '3.50',
      })?.listingSettings,
    ).toEqual({
      address: { countryCode: 'GB', state: null },
      shipping: { type: 'manual', nationalCostCents: 350 },
    });
    expect(
      issuesOf({
        ...sandbox,
        DEPOP_NATIONAL_SHIPPING_COST: '3.50',
        DEPOP_SHIP_FROM_ADDRESS_ID: '1',
      }),
    ).toEqual([
      "DEPOP_NATIONAL_SHIPPING_COST and DEPOP_SHIP_FROM_ADDRESS_ID, DEPOP_SHIPPING_PROVIDER_ID, DEPOP_PARCEL_SIZE_ID, DEPOP_SHIPPING_PAYER can't be set together",
    ]);
    expect(issuesOf({ ...sandbox, DEPOP_SHIP_FROM_ADDRESS_ID: 'abc' })).toEqual([
      'DEPOP_SHIP_FROM_ADDRESS_ID must be a Depop seller address id (digits)',
      'DEPOP_PARCEL_SIZE_ID is required with DEPOP_SHIP_FROM_ADDRESS_ID',
    ]);
    expect(issuesOf({ ...sandbox, DEPOP_PARCEL_SIZE_ID: 'SMALL' })).toEqual([
      'DEPOP_PARCEL_SIZE_ID needs DEPOP_SHIP_FROM_ADDRESS_ID',
    ]);
    expect(issuesOf({ ...sandbox, DEPOP_NATIONAL_SHIPPING_COST: 'free' })).toEqual([
      'DEPOP_NATIONAL_SHIPPING_COST must be an amount such as 4.99',
    ]);
    expect(issuesOf({ ...sandbox, DEPOP_ITEM_COUNTRY: 'usa' })).toEqual([
      'DEPOP_ITEM_COUNTRY must be a two-letter country code such as US',
    ]);
  });

  it("takes a share of Depop's application allowance per process", () => {
    expect(
      loadDepopConfig({ DEPOP_ENV: 'fake', DEPOP_APP_REQUESTS_PER_MINUTE: '15000' })
        ?.applicationRequestsPerMinute,
    ).toBe(15_000);
    expect(issuesOf({ DEPOP_ENV: 'fake', DEPOP_APP_REQUESTS_PER_MINUTE: '40000' })).toEqual([
      'DEPOP_APP_REQUESTS_PER_MINUTE must be an integer from 1 to 30000',
    ]);
  });
});
