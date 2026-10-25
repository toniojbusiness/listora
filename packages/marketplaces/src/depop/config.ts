/**
 * Depop configuration from the environment (`.env.example` documents every key), read once at
 * startup. `DEPOP_ENV` picks the hosts: `fake` (the fake Depop at `DEPOP_FAKE_URL`, for
 * development and tests), `sandbox` (Depop's staging API), or `production`. Without
 * `DEPOP_ENV` there is no Depop API adapter: Depop listings run assisted, as they must until
 * Listora's partner access is granted. Nothing needs a real key unless `DEPOP_ENV` is
 * `sandbox` or `production`. Errors name the bad key, never its value. The single configured
 * seller is a development and sandbox convenience only (`seller`).
 */
import { DEPOP_RATE_LIMITS } from './rate-limits.ts';
import { depopCents } from './payload.ts';
import type { DepopListingSettings } from './seller.ts';
import {
  FAKE_DEPOP_ADDRESS_ID,
  FAKE_DEPOP_CLIENT_ID,
  FAKE_DEPOP_CLIENT_SECRET,
  FAKE_DEPOP_ITEM_ADDRESS,
  FAKE_DEPOP_REFRESH_TOKEN,
  FAKE_DEPOP_SHIPPING,
} from './fake/constants.ts';

export const DEPOP_ENVIRONMENTS = ['fake', 'sandbox', 'production'] as const;
export type DepopEnvironment = (typeof DEPOP_ENVIRONMENTS)[number];

/** Where each part of Depop lives. */
export interface DepopEndpoints {
  /** The Selling API's host. */
  api: string;
  /** The OAuth token endpoint. */
  oauthToken: string;
  /** Depop's consent page, where a seller connects Listora. */
  authorize: string;
}

export const DEFAULT_DEPOP_FAKE_URL = 'http://127.0.0.1:4300';

export function depopEndpoints(
  environment: DepopEnvironment,
  fakeUrl = DEFAULT_DEPOP_FAKE_URL,
): DepopEndpoints {
  switch (environment) {
    case 'production':
      return {
        api: 'https://partnerapi.depop.com',
        oauthToken: 'https://partnerapi.depop.com/api/v1/oauth2/access-token/',
        authorize: 'https://www.depop.com/settings/oauth/apps/',
      };
    case 'sandbox':
      // The Selling API's documented staging server. Depop's OAuth guide has testing clients
      // consent on www.depop.com too; confirm both once partner access is granted.
      return {
        api: 'https://partnerapi-staging.depop.com',
        oauthToken: 'https://partnerapi-staging.depop.com/api/v1/oauth2/access-token/',
        authorize: 'https://www.depop.com/settings/oauth/apps/',
      };
    case 'fake': {
      const base = fakeUrl.replace(/\/+$/, '');
      return {
        api: base,
        oauthToken: `${base}/api/v1/oauth2/access-token/`,
        authorize: `${base}/settings/oauth/apps/`,
      };
    }
  }
}

export interface DepopConfig {
  environment: DepopEnvironment;
  endpoints: DepopEndpoints;
  /** Listora's OAuth client (the fake's own in `fake`). */
  clientId: string;
  clientSecret: string;
  /**
   * The one seller this process lists for in `fake` and `sandbox`, until Depop connections and
   * their token vault land (T-16): a refresh token from the seller's consent
   * (`DEPOP_USER_REFRESH_TOKEN`; in `fake`, the fake's development seller by default), bound to
   * the one Listora connection it acts for (`DEPOP_USER_CONNECTION_ID`). Depop rotates refresh
   * tokens, so the rotated ones live in this process's memory: after a restart this token is
   * used up, and the seller consents again. Every other connection fails with "Connect Depop".
   * Always unset in `production`, which refuses one: one seller's account must never act for
   * every Listora user.
   */
  seller: { refreshToken: string; connectionId: string } | undefined;
  /** How the configured seller's listings ship; `null` without it (the seller's own, later). */
  listingSettings: DepopListingSettings | null;
  /** This process's share of Depop's application-wide request allowance, per minute. */
  applicationRequestsPerMinute: number;
}

export class DepopConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Depop configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'DepopConfigError';
    this.issues = issues;
  }
}

const SHIPPING_KEYS = [
  'DEPOP_SHIP_FROM_ADDRESS_ID',
  'DEPOP_SHIPPING_PROVIDER_ID',
  'DEPOP_PARCEL_SIZE_ID',
  'DEPOP_SHIPPING_PAYER',
] as const;

/** The Depop configuration, or `undefined` when `DEPOP_ENV` is unset (Depop runs assisted). */
export function loadDepopConfig(env: NodeJS.ProcessEnv = process.env): DepopConfig | undefined {
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const rawEnvironment = value('DEPOP_ENV');
  if (rawEnvironment === undefined) return undefined;
  const environment = DEPOP_ENVIRONMENTS.find((name) => name === rawEnvironment);
  if (environment === undefined) {
    throw new DepopConfigError([`DEPOP_ENV must be one of ${DEPOP_ENVIRONMENTS.join(', ')}`]);
  }

  const issues: string[] = [];
  const isFake = environment === 'fake';
  const fakeUrl = value('DEPOP_FAKE_URL') ?? DEFAULT_DEPOP_FAKE_URL;
  if (isFake && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(fakeUrl)) {
    issues.push('DEPOP_FAKE_URL must be an http://127.0.0.1:<port> URL');
  }
  const clientId = value('DEPOP_CLIENT_ID') ?? (isFake ? FAKE_DEPOP_CLIENT_ID : undefined);
  const clientSecret =
    value('DEPOP_CLIENT_SECRET') ?? (isFake ? FAKE_DEPOP_CLIENT_SECRET : undefined);
  if (clientId === undefined) {
    issues.push(`DEPOP_CLIENT_ID is required when DEPOP_ENV is ${environment}`);
  }
  if (clientSecret === undefined) {
    issues.push(`DEPOP_CLIENT_SECRET is required when DEPOP_ENV is ${environment}`);
  }
  const seller = configuredSeller(environment, value, issues);
  const listingSettings = configuredSettings(environment, value, issues);
  if (seller !== undefined && listingSettings === null) {
    issues.push(
      'DEPOP_USER_CONNECTION_ID needs DEPOP_SHIP_FROM_ADDRESS_ID (Depop Shipping) or DEPOP_NATIONAL_SHIPPING_COST',
    );
  }

  const rawRate =
    value('DEPOP_APP_REQUESTS_PER_MINUTE') ?? String(DEPOP_RATE_LIMITS.application.requests);
  const applicationRequestsPerMinute = Number(rawRate);
  if (
    !/^\d+$/.test(rawRate) ||
    applicationRequestsPerMinute < 1 ||
    applicationRequestsPerMinute > DEPOP_RATE_LIMITS.application.requests
  ) {
    issues.push(
      `DEPOP_APP_REQUESTS_PER_MINUTE must be an integer from 1 to ${String(DEPOP_RATE_LIMITS.application.requests)}`,
    );
  }

  if (issues.length > 0 || clientId === undefined || clientSecret === undefined) {
    throw new DepopConfigError(issues);
  }
  return {
    environment,
    endpoints: depopEndpoints(environment, fakeUrl),
    clientId,
    clientSecret,
    seller,
    listingSettings,
    applicationRequestsPerMinute,
  };
}

/** The single configured seller (`DepopConfig.seller`), recording what is wrong in `issues`. */
function configuredSeller(
  environment: DepopEnvironment,
  value: (key: string) => string | undefined,
  issues: string[],
): DepopConfig['seller'] {
  const refreshToken = value('DEPOP_USER_REFRESH_TOKEN');
  const connectionId = value('DEPOP_USER_CONNECTION_ID');
  if (environment === 'production') {
    for (const key of ['DEPOP_USER_REFRESH_TOKEN', 'DEPOP_USER_CONNECTION_ID'] as const) {
      if (value(key) !== undefined) {
        issues.push(
          `${key} is not allowed when DEPOP_ENV is production (each Depop connection has its own token)`,
        );
      }
    }
    return undefined;
  }
  if (connectionId === undefined) {
    if (refreshToken !== undefined) {
      issues.push('DEPOP_USER_CONNECTION_ID is required with DEPOP_USER_REFRESH_TOKEN');
    }
    return undefined;
  }
  const token = refreshToken ?? (environment === 'fake' ? FAKE_DEPOP_REFRESH_TOKEN : undefined);
  if (token === undefined) {
    issues.push(
      `DEPOP_USER_CONNECTION_ID needs DEPOP_USER_REFRESH_TOKEN when DEPOP_ENV is ${environment}`,
    );
    return undefined;
  }
  return { refreshToken: token, connectionId };
}

/**
 * How the configured seller's listings ship: Depop Shipping from a shop address
 * (`DEPOP_SHIP_FROM_ADDRESS_ID` and the provider and parcel size its shipping providers offer),
 * or a national shipping cost (`DEPOP_NATIONAL_SHIPPING_COST`). `fake` defaults to the fake's
 * development seller's address. `null` when neither is set.
 */
function configuredSettings(
  environment: DepopEnvironment,
  value: (key: string) => string | undefined,
  issues: string[],
): DepopListingSettings | null {
  const isFake = environment === 'fake';
  const country = value('DEPOP_ITEM_COUNTRY') ?? FAKE_DEPOP_ITEM_ADDRESS.countryCode;
  if (!/^[A-Z]{2}$/.test(country)) {
    issues.push('DEPOP_ITEM_COUNTRY must be a two-letter country code such as US');
  }
  const address = {
    countryCode: country,
    state: value('DEPOP_ITEM_STATE') ?? (isFake ? FAKE_DEPOP_ITEM_ADDRESS.state : null),
  };

  const nationalCost = value('DEPOP_NATIONAL_SHIPPING_COST');
  if (nationalCost !== undefined) {
    if (SHIPPING_KEYS.some((key) => value(key) !== undefined)) {
      issues.push(
        `DEPOP_NATIONAL_SHIPPING_COST and ${SHIPPING_KEYS.join(', ')} can't be set together`,
      );
    }
    const cents = depopCents(nationalCost);
    if (cents === null) {
      issues.push('DEPOP_NATIONAL_SHIPPING_COST must be an amount such as 4.99');
      return null;
    }
    return { address, shipping: { type: 'manual', nationalCostCents: cents } };
  }

  const rawAddressId =
    value('DEPOP_SHIP_FROM_ADDRESS_ID') ?? (isFake ? String(FAKE_DEPOP_ADDRESS_ID) : undefined);
  if (rawAddressId === undefined) {
    const stray = SHIPPING_KEYS.filter((key) => value(key) !== undefined);
    if (stray.length > 0) {
      issues.push(
        `${stray.join(', ')} ${stray.length === 1 ? 'needs' : 'need'} DEPOP_SHIP_FROM_ADDRESS_ID`,
      );
    }
    return null;
  }
  if (!/^\d{1,18}$/.test(rawAddressId)) {
    issues.push('DEPOP_SHIP_FROM_ADDRESS_ID must be a Depop seller address id (digits)');
  }
  const providerId = value('DEPOP_SHIPPING_PROVIDER_ID') ?? FAKE_DEPOP_SHIPPING.providerId;
  const parcelSizeId =
    value('DEPOP_PARCEL_SIZE_ID') ?? (isFake ? FAKE_DEPOP_SHIPPING.parcelSizeId : undefined);
  if (parcelSizeId === undefined) {
    issues.push('DEPOP_PARCEL_SIZE_ID is required with DEPOP_SHIP_FROM_ADDRESS_ID');
  }
  const payer = value('DEPOP_SHIPPING_PAYER') ?? 'buyer';
  if (payer !== 'buyer' && payer !== 'seller') {
    issues.push('DEPOP_SHIPPING_PAYER must be buyer or seller');
  }
  return {
    address,
    shipping: {
      type: 'depop',
      addressId: Number(rawAddressId),
      providerId,
      parcelSizeId: parcelSizeId ?? '',
      payer: payer === 'seller' ? 'seller' : 'buyer',
    },
  };
}
