/**
 * Connecting a seller's marketplace account through the marketplace's official OAuth 2.0
 * authorization code grant (docs/features/marketplaces.md). One `MarketplaceOAuthClient` per
 * marketplace that has one (eBay first, `ebay/oauth.ts`); `@listora/connections` drives it, and
 * keeps the tokens it returns encrypted in the token vault.
 *
 * Like adapters, clients never throw for a marketplace's answer: every call returns a result
 * that says what happened, so callers can tell a seller who has to reconnect
 * (`reauth_required`) from a marketplace that is only unavailable for now. Listora never asks
 * for, sees, or stores marketplace passwords: the seller signs in on the marketplace's own page.
 */
import type { Marketplace } from '@listora/db';

/** A grant's tokens. Secrets: never logged, stored only encrypted (`@listora/connections`). */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** What a code exchange returns. */
export interface OAuthGrant {
  tokens: OAuthTokens;
  accessExpiresAt: Date;
  /** When the refresh token stops working and the seller must consent again; null if unknown. */
  refreshExpiresAt: Date | null;
  /** The scopes the seller consented to. */
  scopes: string[];
}

/** A failure: stable machine-readable `code`, and a user-readable `message` naming the marketplace. */
export interface OAuthFailure {
  code: string;
  message: string;
}

export type CodeExchangeResult =
  | { type: 'granted'; grant: OAuthGrant }
  /** The code is invalid, used, or expired: the seller has to start again. */
  | ({ type: 'rejected' } & OAuthFailure)
  /** The marketplace could not be asked (5xx, 429, unreachable, a timeout). */
  | ({ type: 'unavailable'; retryAfterMs?: number } & OAuthFailure);

export type TokenRefreshResult =
  | {
      type: 'refreshed';
      accessToken: string;
      accessExpiresAt: Date;
      /** Present when the marketplace rotates refresh tokens (Depop); eBay keeps the old one. */
      refreshToken?: string;
      refreshExpiresAt?: Date;
    }
  /** The refresh token was revoked or expired: only the seller's consent can fix it. */
  | ({ type: 'reauth_required' } & OAuthFailure)
  | ({ type: 'unavailable'; retryAfterMs?: number } & OAuthFailure);

export type IdentityResult =
  | {
      type: 'identified';
      /** The marketplace's immutable id for the seller (eBay `userId`). */
      externalUserId: string;
      /** The seller's name there, for display; it can change. */
      displayName: string | null;
    }
  /** The access token does not work (expired early, revoked): refresh, or reconnect. */
  | ({ type: 'unauthorized' } & OAuthFailure)
  | ({ type: 'unavailable'; retryAfterMs?: number } & OAuthFailure);

export interface OAuthCallContext {
  /** Aborted when the caller gives up (a request or job deadline, shutdown). */
  signal: AbortSignal;
  /** The clock expiry times are computed from. */
  now: Date;
}

export interface MarketplaceOAuthClient {
  readonly marketplace: Marketplace;
  /** The scopes every consent request asks for. */
  readonly scopes: readonly string[];
  /**
   * The marketplace's consent page for a new connection. `state` is an unguessable single-use
   * value the marketplace sends back to the callback with the code.
   */
  authorizationUrl(state: string): string;
  /** Exchanges the code from the callback for the seller's tokens. */
  exchangeCode(code: string, ctx: OAuthCallContext): Promise<CodeExchangeResult>;
  /** A new access token from the refresh token. */
  refresh(refreshToken: string, ctx: OAuthCallContext): Promise<TokenRefreshResult>;
  /**
   * Who the access token belongs to. Also the connection health check's one cheap call: it
   * proves the token works without touching listings.
   */
  identify(accessToken: string, ctx: OAuthCallContext): Promise<IdentityResult>;
  /**
   * Asks the marketplace to revoke the grant. True only when it confirmed; false, never a
   * throw, otherwise. Safe to repeat for a grant that is already revoked.
   */
  revoke(tokens: OAuthTokens, ctx: OAuthCallContext): Promise<boolean>;
}

/** The OAuth clients a process has, by marketplace. A marketplace without one cannot connect. */
export type OAuthClients = Partial<Record<Marketplace, MarketplaceOAuthClient>>;
