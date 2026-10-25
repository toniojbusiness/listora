/**
 * The seller behind a Depop connection, as the Depop adapter needs it: an access token and how
 * the seller's listings ship. The token vault (T-16) implements it per connection (tokens.ts
 * holds the rotation-safe token logic over its store); until then `createDepopAdapter` serves
 * the one development or sandbox seller configured in the environment.
 */
import type { ConnectionRef } from '../adapter.ts';

/**
 * Where a seller's items are and how they ship. Depop needs a product `address` (country and
 * state) and either Depop Shipping (`depop_shipping`: the seller's address id, a provider, and a
 * parcel size from the shop's shipping providers) or a national shipping cost. "Manual shipping
 * is not available to most US sellers", so US sellers use Depop Shipping.
 */
export interface DepopListingSettings {
  address: { countryCode: string; state: string | null };
  shipping:
    | {
        type: 'depop';
        addressId: number;
        providerId: string;
        parcelSizeId: string;
        payer: 'buyer' | 'seller';
      }
    | { type: 'manual'; nationalCostCents: number };
}

export interface DepopSellerSource {
  /**
   * The connection's current access token. Throws `DepopReauthRequiredError` when the seller
   * must connect Depop (again), or the connection has no seller here, and
   * `DepopTokenUnavailableError` when one can't be had right now.
   */
  accessToken(connection: ConnectionRef | null, signal: AbortSignal): Promise<string>;
  /** Depop refused this token: the next call gets a fresh one. */
  forget(connection: ConnectionRef | null, token: string): void;
  /** How the seller's listings ship; `null` until the seller's settings are known. */
  listingSettings(connection: ConnectionRef | null): DepopListingSettings | null;
}
