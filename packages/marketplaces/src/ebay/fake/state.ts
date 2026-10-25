/**
 * What the fake eBay holds: sellers with their OAuth grants and business policies, listings
 * with the state eBay keeps for them, EPS images, and orders. The HTTP handlers (trading.ts,
 * rest.ts, oauth.ts) read and change it; tests inspect it through `FakeEbay`.
 */
export type FakeListingStatus = 'Active' | 'Ended' | 'Completed';

export interface FakeItemSpecific {
  name: string;
  values: string[];
}

/** A listing as eBay stores it (the Trading `Item`), in eBay's own terms. */
export interface FakeEbayListing {
  itemId: string;
  sellerUserId: string;
  sku: string | null;
  /** `InventoryTrackingMethod` was `SKU`: the SKU identifies the listing in GetItem and End. */
  trackedBySku: boolean;
  uuid: string | null;
  title: string;
  /** HTML, as sent in `Item.Description`. */
  description: string;
  categoryId: string;
  conditionId: number;
  conditionDescription: string | null;
  /** `StartPrice` as eBay echoes it, for example `45.0`. */
  price: string;
  currency: string;
  quantity: number;
  quantitySold: number;
  pictureUrls: string[];
  itemSpecifics: FakeItemSpecific[];
  postalCode: string | null;
  dispatchTimeMax: number | null;
  sellerProfiles: { shipping: string; payment: string; return: string } | null;
  status: FakeListingStatus;
  startTime: string;
  endTime: string;
  endingReason: string | null;
  relistedItemId: string | null;
  revised: boolean;
}

export interface FakeSeller {
  userId: string;
  username: string;
  /** Refresh tokens that still work (revoking one makes the token endpoint refuse it). */
  refreshTokens: Set<string>;
  policies: { shipping: string; payment: string; return: string };
}

export interface FakeAccessToken {
  /** `null` for an application token (client-credentials grant). */
  sellerUserId: string | null;
  expiresAt: number;
  /** The refresh token it was issued from (revoking that one revokes it too). */
  refreshToken?: string;
}

export interface FakeOrder {
  orderId: string;
  sellerUserId: string;
  itemId: string;
  sku: string | null;
  title: string;
  buyer: string;
  priceValue: string;
  currency: string;
  creationDate: string;
  lastModifiedDate: string;
  cancelState: 'NONE_REQUESTED' | 'CANCELED';
  /** What the buyer paid for shipping, as eBay echoes amounts (`4.99`). */
  shippingValue: string;
  shipByDate: string;
}
