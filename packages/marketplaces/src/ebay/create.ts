/**
 * Builds the eBay adapter a process runs with from its configuration (config.ts): the OAuth
 * client, the seller's tokens, the application token, the Trading call budget (synced with
 * eBay's Developer Analytics usage), and the adapter.
 */
import { EbayAdapter } from './adapter.ts';
import { DailyCallBudget } from './budget.ts';
import type { EbayConfig } from './config.ts';
import {
  ApplicationToken,
  EbayOAuthClient,
  EbayReauthRequiredError,
  RefreshTokenSeller,
  type EbayListingSettings,
  type EbaySellerSource,
} from './oauth.ts';
import { AnalyticsTradingUsage } from './rest.ts';

export interface CreateEbayAdapterOptions {
  /** Per-request timeout for every eBay call. */
  requestTimeoutMs?: number;
  now?: () => number;
}

export function createEbayAdapter(
  config: EbayConfig,
  options: CreateEbayAdapterOptions = {},
): EbayAdapter {
  const oauth = new EbayOAuthClient({
    tokenUrl: config.endpoints.oauthToken,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const applicationToken = new ApplicationToken(oauth, options.now);
  const seller: EbaySellerSource =
    config.seller === undefined
      ? new UnconnectedSeller(config.listingSettings)
      : new RefreshTokenSeller({
          oauth,
          refreshToken: config.seller.refreshToken,
          connectionId: config.seller.connectionId,
          settings: config.listingSettings,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  const endpoints = { api: config.endpoints.api, media: config.endpoints.media };
  return new EbayAdapter({
    endpoints: config.endpoints,
    seller,
    applicationToken,
    budget: new DailyCallBudget({
      dailyLimit: config.tradingDailyLimit,
      usage: new AnalyticsTradingUsage(endpoints, applicationToken, {
        ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    tradingDailyLimit: config.tradingDailyLimit,
    // eBay's sandbox answers category suggestions with boilerplate names.
    categorySuggestions: config.environment !== 'sandbox',
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
}

/** No seller has connected eBay: every call asks for the connection (honestly, never silently). */
class UnconnectedSeller implements EbaySellerSource {
  readonly #settings: EbayListingSettings;

  constructor(settings: EbayListingSettings) {
    this.#settings = settings;
  }

  accessToken(): Promise<string> {
    return Promise.reject(new EbayReauthRequiredError('Connect eBay to list there.'));
  }

  forget(): void {
    // Nothing is cached.
  }

  listingSettings(): EbayListingSettings {
    return this.#settings;
  }
}
