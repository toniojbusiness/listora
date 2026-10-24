import type { Marketplace } from '@listora/db';

/** An API connection whose marketplace grant account deletion asks to revoke. */
export interface GrantToRevoke {
  connectionId: string;
  marketplace: Marketplace;
  /** The stored OAuth tokens, encrypted (decrypting them is the token vault's job, T-16). */
  tokenCiphertext: Buffer;
}

/**
 * Revokes Listora's access to a seller's marketplace account through the marketplace's
 * official revocation endpoint. Marketplace adapters implement it as they add OAuth
 * connections (eBay in T-16, Depop in T-24).
 */
export interface MarketplaceAccessRevoker {
  /**
   * True only when the marketplace confirmed that the grant is revoked. False, or a thrown
   * error, when it did not: the caller reports the grant as not revoked and never pretends.
   * Implementations bound their own time, so a slow marketplace cannot stall account deletion.
   */
  revoke(grant: GrantToRevoke): Promise<boolean>;
}

/**
 * Until a marketplace adapter can revoke its grants, nothing is revoked, and account deletion
 * says so for every connection that still holds tokens.
 */
export const noMarketplaceAccessRevocation: MarketplaceAccessRevoker = {
  revoke: () => Promise.resolve(false),
};
