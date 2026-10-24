import type { Marketplace } from '@listora/db';

/** A deleted account's API connection whose marketplace grant the deletion job asks to revoke. */
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
   * error, when it did not: the job asks again later and never pretends. It must be safe to ask
   * again for a grant that is already revoked (a crash can repeat a confirmed revocation).
   * Implementations bound their own time, so a slow marketplace cannot stall the job.
   */
  revoke(grant: GrantToRevoke): Promise<boolean>;
}

/**
 * Until a marketplace adapter can revoke its grants, nothing is revoked: the deletion job keeps
 * asking until it gives up, and then records that the seller must revoke them.
 */
export const noMarketplaceAccessRevocation: MarketplaceAccessRevoker = {
  revoke: () => Promise.resolve(false),
};
