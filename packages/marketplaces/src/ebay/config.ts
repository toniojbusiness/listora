/**
 * eBay configuration from the environment (`.env.example` documents every key), read once at
 * startup. `EBAY_ENV` picks the hosts: `fake` (the fake-ebay server at `EBAY_FAKE_URL`, the
 * default for development and tests), `sandbox`, or `production`. Nothing needs a real key
 * unless `EBAY_ENV` is `sandbox` or `production`. Errors name the bad key, never its value.
 * The single configured seller is a development and sandbox convenience only (`seller`).
 */
import type { EbayListingSettings } from './oauth.ts';
import { DEFAULT_LISTING_SETTINGS } from './oauth.ts';
import { DEFAULT_TRADING_DAILY_LIMIT } from './budget.ts';
import { EBAY_VERIFICATION_TOKEN_PATTERN } from './notification-events.ts';
import type { EbayNotificationSettings } from './notification-subscriptions.ts';
import {
  FAKE_EBAY_CLIENT_ID,
  FAKE_EBAY_CLIENT_SECRET,
  FAKE_EBAY_REFRESH_TOKEN,
  FAKE_EBAY_RU_NAME,
} from './fake/constants.ts';

export const EBAY_ENVIRONMENTS = ['fake', 'sandbox', 'production'] as const;
export type EbayEnvironment = (typeof EBAY_ENVIRONMENTS)[number];

/** Where each eBay API lives. */
export interface EbayEndpoints {
  /** The Trading API gateway (`/ws/api.dll`). */
  trading: string;
  /** REST APIs on `api.ebay.com`: Taxonomy, Fulfillment, Notification, Developer Analytics. */
  api: string;
  /** The Media API's host (`apim.ebay.com`). */
  media: string;
  /** The OAuth token endpoint. */
  oauthToken: string;
  /** Where a seller grants consent (eBay connect). */
  authorize: string;
  /** The OAuth token revocation endpoint (`token/revoke`). */
  oauthRevoke: string;
  /** Commerce Identity `getUser`: the seller a user token belongs to (`apiz.ebay.com`). */
  identity: string;
}

export const DEFAULT_EBAY_FAKE_URL = 'http://127.0.0.1:4200';

export function ebayEndpoints(
  environment: EbayEnvironment,
  fakeUrl = DEFAULT_EBAY_FAKE_URL,
): EbayEndpoints {
  switch (environment) {
    case 'production':
      return {
        trading: 'https://api.ebay.com/ws/api.dll',
        api: 'https://api.ebay.com',
        media: 'https://apim.ebay.com',
        oauthToken: 'https://api.ebay.com/identity/v1/oauth2/token',
        authorize: 'https://auth.ebay.com/oauth2/authorize',
        oauthRevoke: 'https://api.ebay.com/identity/v1/oauth2/token/revoke',
        identity: 'https://apiz.ebay.com/commerce/identity/v1/user',
      };
    case 'sandbox':
      return {
        trading: 'https://api.sandbox.ebay.com/ws/api.dll',
        api: 'https://api.sandbox.ebay.com',
        media: 'https://apim.sandbox.ebay.com',
        oauthToken: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
        authorize: 'https://auth.sandbox.ebay.com/oauth2/authorize',
        // eBay documents the production revocation URL; the Sandbox follows its token endpoint.
        oauthRevoke: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token/revoke',
        identity: 'https://apiz.sandbox.ebay.com/commerce/identity/v1/user',
      };
    case 'fake': {
      const base = fakeUrl.replace(/\/+$/, '');
      return {
        trading: `${base}/ws/api.dll`,
        api: base,
        media: base,
        oauthToken: `${base}/identity/v1/oauth2/token`,
        authorize: `${base}/oauth2/authorize`,
        oauthRevoke: `${base}/identity/v1/oauth2/token/revoke`,
        identity: `${base}/commerce/identity/v1/user`,
      };
    }
  }
}

export interface EbayConfig {
  environment: EbayEnvironment;
  endpoints: EbayEndpoints;
  /** The application keyset (the fake's own in `fake`). */
  clientId: string;
  clientSecret: string;
  /**
   * The keyset's RuName (eBay redirect URL name; `EBAY_RUNAME`, the fake's own in `fake`). Its
   * "auth accepted" and "auth declined" URLs, set in the eBay developer portal, are the API's
   * `/v1/connections/ebay/callback`. Without one, sellers cannot connect eBay accounts.
   */
  ruName: string | undefined;
  /**
   * The one seller this process lists for in `fake` and `sandbox`, until eBay connections and
   * their token vault land (T-16): a refresh token from the seller's consent
   * (`EBAY_USER_REFRESH_TOKEN`; in `fake`, the fake's development seller by default), bound to
   * the one Listora connection it acts for (`EBAY_USER_CONNECTION_ID`). Every other connection,
   * and a listing with none, fails with "connect eBay", as does every operation when this is
   * unset. Always unset in `production`, which refuses a configured seller: one seller's
   * account must never act for every Listora user.
   */
  seller: { refreshToken: string; connectionId: string } | undefined;
  listingSettings: EbayListingSettings;
  /** The application's daily Trading API call limit, until eBay reports it (budget.ts). */
  tradingDailyLimit: number;
  /**
   * Where eBay delivers notifications (`EBAY_NOTIFICATION_ENDPOINT`, the API's
   * `/webhooks/ebay`), its verification token, and the alert email. Unset: no notifications,
   * and the order poll alone finds sales.
   */
  notifications: EbayNotificationSettings | undefined;
}

export class EbayConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid eBay configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'EbayConfigError';
    this.issues = issues;
  }
}

/** The eBay configuration, or `undefined` when `EBAY_ENV` is unset (eBay is not configured). */
export function loadEbayConfig(env: NodeJS.ProcessEnv = process.env): EbayConfig | undefined {
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const rawEnvironment = value('EBAY_ENV');
  if (rawEnvironment === undefined) return undefined;
  const environment = EBAY_ENVIRONMENTS.find((name) => name === rawEnvironment);
  if (environment === undefined) {
    throw new EbayConfigError([`EBAY_ENV must be one of ${EBAY_ENVIRONMENTS.join(', ')}`]);
  }

  const issues: string[] = [];
  const fakeUrl = value('EBAY_FAKE_URL') ?? DEFAULT_EBAY_FAKE_URL;
  if (environment === 'fake' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(fakeUrl)) {
    issues.push('EBAY_FAKE_URL must be an http://127.0.0.1:<port> URL');
  }

  const isFake = environment === 'fake';
  const clientId = value('EBAY_CLIENT_ID') ?? (isFake ? FAKE_EBAY_CLIENT_ID : undefined);
  const clientSecret =
    value('EBAY_CLIENT_SECRET') ?? (isFake ? FAKE_EBAY_CLIENT_SECRET : undefined);
  if (clientId === undefined)
    issues.push(`EBAY_CLIENT_ID is required when EBAY_ENV is ${environment}`);
  const ruName = value('EBAY_RUNAME') ?? (isFake ? FAKE_EBAY_RU_NAME : undefined);
  if (clientSecret === undefined) {
    issues.push(`EBAY_CLIENT_SECRET is required when EBAY_ENV is ${environment}`);
  }
  const seller = configuredSeller(environment, value, issues);

  const postalCode = value('EBAY_ITEM_POSTAL_CODE') ?? DEFAULT_LISTING_SETTINGS.postalCode;
  if (!/^\d{5}(-\d{4})?$/.test(postalCode)) {
    issues.push('EBAY_ITEM_POSTAL_CODE must be a US ZIP code');
  }
  const dispatch = value('EBAY_DISPATCH_DAYS') ?? String(DEFAULT_LISTING_SETTINGS.dispatchTimeMax);
  if (!/^[0-3]$/.test(dispatch)) issues.push('EBAY_DISPATCH_DAYS must be 0, 1, 2, or 3');

  const policyKeys = [
    'EBAY_FULFILLMENT_POLICY_ID',
    'EBAY_PAYMENT_POLICY_ID',
    'EBAY_RETURN_POLICY_ID',
  ] as const;
  const policyValues = policyKeys.map(value);
  const given = policyValues.filter((policy) => policy !== undefined).length;
  if (given !== 0 && given !== policyKeys.length) {
    issues.push(`${policyKeys.join(', ')} must be set together, or not at all`);
  }
  for (const [index, policy] of policyValues.entries()) {
    if (policy !== undefined && !/^\d{1,19}$/.test(policy)) {
      issues.push(`${policyKeys[index] ?? ''} must be an eBay business policy id (digits)`);
    }
  }
  const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = policyValues;

  const rawLimit = value('EBAY_TRADING_DAILY_CALL_LIMIT') ?? String(DEFAULT_TRADING_DAILY_LIMIT);
  const tradingDailyLimit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || tradingDailyLimit < 100 || tradingDailyLimit > 10_000_000) {
    issues.push('EBAY_TRADING_DAILY_CALL_LIMIT must be an integer from 100 to 10000000');
  }

  const notifications = notificationSettings(environment, value, issues);

  if (issues.length > 0 || clientId === undefined || clientSecret === undefined) {
    throw new EbayConfigError(issues);
  }
  return {
    environment,
    endpoints: ebayEndpoints(environment, fakeUrl),
    clientId,
    clientSecret,
    ruName,
    seller,
    listingSettings: {
      postalCode,
      dispatchTimeMax: Number(dispatch),
      policies:
        fulfillmentPolicyId === undefined ||
        paymentPolicyId === undefined ||
        returnPolicyId === undefined
          ? null
          : { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
    },
    tradingDailyLimit,
    notifications,
  };
}

/** eBay notification settings (`EbayConfig.notifications`), recording problems in `issues`. */
function notificationSettings(
  environment: EbayEnvironment,
  value: (key: string) => string | undefined,
  issues: string[],
): EbayNotificationSettings | undefined {
  const endpoint = value('EBAY_NOTIFICATION_ENDPOINT');
  const verificationToken = value('EBAY_NOTIFICATION_VERIFICATION_TOKEN');
  const alertEmail = value('EBAY_NOTIFICATION_ALERT_EMAIL') ?? null;
  if (endpoint === undefined) {
    if (verificationToken !== undefined) {
      issues.push('EBAY_NOTIFICATION_VERIFICATION_TOKEN needs EBAY_NOTIFICATION_ENDPOINT');
    }
    return undefined;
  }
  const url = URL.parse(endpoint);
  const local = url !== null && /^(127\.0\.0\.1|localhost)$/.test(url.hostname);
  // eBay delivers only to https URLs that are not localhost; the fake also to the local API.
  const allowed =
    url?.search === '' &&
    url.hash === '' &&
    (environment === 'fake'
      ? url.protocol === 'http:' || url.protocol === 'https:'
      : url.protocol === 'https:' && !local);
  if (!allowed) {
    issues.push(
      environment === 'fake'
        ? 'EBAY_NOTIFICATION_ENDPOINT must be an http(s) URL without a query'
        : 'EBAY_NOTIFICATION_ENDPOINT must be a public https URL without a query',
    );
  }
  if (verificationToken === undefined || !EBAY_VERIFICATION_TOKEN_PATTERN.test(verificationToken)) {
    issues.push(
      'EBAY_NOTIFICATION_VERIFICATION_TOKEN must be 32 to 80 letters, digits, underscores, or hyphens',
    );
  }
  if (alertEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) {
    issues.push('EBAY_NOTIFICATION_ALERT_EMAIL must be an email address');
  }
  if (!allowed || verificationToken === undefined) return undefined;
  return { endpoint, verificationToken, alertEmail };
}

/** The single configured seller (`EbayConfig.seller`), recording what is wrong in `issues`. */
function configuredSeller(
  environment: EbayEnvironment,
  value: (key: string) => string | undefined,
  issues: string[],
): EbayConfig['seller'] {
  const refreshToken = value('EBAY_USER_REFRESH_TOKEN');
  const connectionId = value('EBAY_USER_CONNECTION_ID');
  if (environment === 'production') {
    for (const key of ['EBAY_USER_REFRESH_TOKEN', 'EBAY_USER_CONNECTION_ID'] as const) {
      if (value(key) !== undefined) {
        issues.push(
          `${key} is not allowed when EBAY_ENV is production (each eBay connection has its own token)`,
        );
      }
    }
    return undefined;
  }
  if (connectionId === undefined) {
    if (refreshToken !== undefined) {
      issues.push('EBAY_USER_CONNECTION_ID is required with EBAY_USER_REFRESH_TOKEN');
    }
    return undefined;
  }
  const token = refreshToken ?? (environment === 'fake' ? FAKE_EBAY_REFRESH_TOKEN : undefined);
  if (token === undefined) {
    issues.push(
      `EBAY_USER_CONNECTION_ID needs EBAY_USER_REFRESH_TOKEN when EBAY_ENV is ${environment}`,
    );
    return undefined;
  }
  return { refreshToken: token, connectionId };
}
