/**
 * Revokes a deleted account's marketplace grants through each marketplace's official OAuth
 * revocation endpoint (eBay `token/revoke`): the account deletion job's
 * `MarketplaceAccessRevoker` (`@listora/accounts`). It opens the grant's tokens in the vault,
 * which only the worker can, and asks the marketplace. True only when the marketplace
 * confirmed; any other answer, or tokens that cannot be opened, is false, so the job asks again
 * later and finally tells the seller to remove Listora themselves.
 */
import type { Marketplace } from '@listora/db';
import type { OAuthClients } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { TokenVault } from './vault.ts';

const REVOKE_DEADLINE_MS = 20_000;

/** A grant to revoke, as the account deletion job holds it. */
export interface GrantTokens {
  connectionId: string;
  marketplace: Marketplace;
  tokenCiphertext: Buffer;
}

export class OAuthGrantRevoker {
  readonly #vault: TokenVault;
  readonly #oauth: OAuthClients;
  readonly #logger: Logger;

  constructor(deps: { vault: TokenVault; oauth: OAuthClients; logger: Logger }) {
    this.#vault = deps.vault;
    this.#oauth = deps.oauth;
    this.#logger = deps.logger;
  }

  async revoke(grant: GrantTokens): Promise<boolean> {
    const oauth = this.#oauth[grant.marketplace];
    if (oauth === undefined) return false;
    let tokens;
    try {
      tokens = await this.#vault.open(grant.tokenCiphertext, {
        marketplace: grant.marketplace,
        connectionId: grant.connectionId,
      });
    } catch (error) {
      this.#logger.error(
        { err: error, connectionId: grant.connectionId, marketplace: grant.marketplace },
        'could not open the tokens of a grant to revoke',
      );
      return false;
    }
    return oauth.revoke(tokens, {
      signal: AbortSignal.timeout(REVOKE_DEADLINE_MS),
      now: new Date(),
    });
  }
}
