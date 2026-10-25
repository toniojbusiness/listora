/**
 * The eBay adapter's seller tokens per connection (`EbaySellerSource`), from the token vault:
 * each listing's operations act with the access token of the eBay account its connection holds,
 * decrypted and refreshed at use time by `ConnectionTokens`. A listing without an API
 * connection, or a connection that needs the seller, gets "connect eBay" and nothing is sent.
 */
import {
  EbayReauthRequiredError,
  EbayTokenUnavailableError,
  type ConnectionRef,
  type EbayListingSettings,
  type EbaySellerSource,
} from '@listora/marketplaces';

import type { ConnectionTokens } from './credentials.ts';

export class ConnectionSeller implements EbaySellerSource {
  readonly #tokens: ConnectionTokens;
  readonly #settings: EbayListingSettings;

  constructor(options: { tokens: ConnectionTokens; listingSettings: EbayListingSettings }) {
    this.#tokens = options.tokens;
    this.#settings = options.listingSettings;
  }

  async accessToken(connection: ConnectionRef | null, signal: AbortSignal): Promise<string> {
    if (connection?.mode !== 'api') {
      throw new EbayReauthRequiredError('Connect eBay to list there.');
    }
    const result = await this.#tokens.accessToken(connection.id, signal);
    switch (result.type) {
      case 'ok':
        return result.accessToken;
      case 'reauth_required':
        throw new EbayReauthRequiredError(result.message);
      case 'unavailable':
        throw new EbayTokenUnavailableError(result.code);
    }
  }

  forget(connection: ConnectionRef | null, token: string): void {
    if (connection === null) return;
    void this.#tokens.invalidate(connection.id, token).catch(() => undefined);
  }

  listingSettings(): EbayListingSettings {
    return this.#settings;
  }
}
