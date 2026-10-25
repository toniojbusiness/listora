/**
 * Builds the Depop adapter a process runs with from its configuration (config.ts): the OAuth
 * client, the sellers' tokens over a token store, the rate limits, the API client, and the
 * adapter. Without a token store (the token vault, T-16), tokens live in memory and only the one
 * configured development or sandbox seller has any.
 */
import type { Logger } from '@listora/shared';

import { DepopAdapter } from './adapter.ts';
import { DepopApi } from './client.ts';
import type { DepopConfig } from './config.ts';
import { DepopOAuthClient } from './oauth.ts';
import { DepopRateLimiter } from './rate-limits.ts';
import type { DepopSellerSource } from './seller.ts';
import { DepopSellerTokens, MemoryDepopTokenStore, type DepopTokenStore } from './tokens.ts';

export interface CreateDepopAdapterOptions {
  /** Per-request timeout for every Depop call; a write that times out after sending is unknown. */
  requestTimeoutMs?: number;
  /** Where sellers' tokens are kept; default: in memory, holding the configured seller's. */
  tokenStore?: DepopTokenStore;
  logger?: Logger;
  /** How long a refused refresh token waits for another process's tokens (tokens.ts). */
  refusalGraceMs?: number;
  now?: () => number;
}

export function createDepopAdapter(
  config: DepopConfig,
  options: CreateDepopAdapterOptions = {},
): DepopAdapter {
  const oauth = new DepopOAuthClient({
    tokenUrl: config.endpoints.oauthToken,
    authorizeUrl: config.endpoints.authorize,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let store = options.tokenStore;
  if (store === undefined) {
    const memory = new MemoryDepopTokenStore();
    if (config.seller !== undefined) {
      // A refresh token from configuration: its access token is fetched on first use, and when
      // its grant ends is Depop's to say.
      memory.connect(config.seller.connectionId, {
        accessToken: '',
        accessExpiresAt: 0,
        refreshToken: config.seller.refreshToken,
        grantExpiresAt: Number.MAX_SAFE_INTEGER,
      });
    }
    store = memory;
  }
  const tokens = new DepopSellerTokens({
    oauth,
    store,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.refusalGraceMs === undefined ? {} : { refusalGraceMs: options.refusalGraceMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const seller: DepopSellerSource = {
    accessToken: (connection, signal) => tokens.accessToken(connection, signal),
    forget: (connection, token) => {
      tokens.forget(connection, token);
    },
    listingSettings: () => config.listingSettings,
  };
  const api = new DepopApi({
    baseUrl: config.endpoints.api,
    seller,
    limiter: new DepopRateLimiter({
      applicationPerMinute: config.applicationRequestsPerMinute,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    timeoutMs: options.requestTimeoutMs ?? 20_000,
  });
  return new DepopAdapter({ api, seller });
}
