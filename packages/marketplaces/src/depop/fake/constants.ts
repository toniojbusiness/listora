/**
 * The fake Depop's built-in application and development seller, so development needs no Depop
 * credential (`DEPOP_ENV=fake` uses them when the DEPOP_* keys are unset). None is a secret.
 */

export const FAKE_DEPOP_CLIENT_ID = 'listora-fake-depop-client';
export const FAKE_DEPOP_CLIENT_SECRET = 'listora-fake-depop-client-secret';

/** The development seller's refresh token when the fake starts. */
export const FAKE_DEPOP_REFRESH_TOKEN = 'prt_listora_fake_development_seller';

/** The development seller's shop address, for Depop Shipping. */
export const FAKE_DEPOP_ADDRESS_ID = 100001;

/** A Depop Shipping provider and parcel size the development seller's address offers. */
export const FAKE_DEPOP_SHIPPING = { providerId: 'USPS', parcelSizeId: 'SMALL' } as const;

/** Where the development seller's items are. */
export const FAKE_DEPOP_ITEM_ADDRESS = { countryCode: 'US', state: 'California' } as const;
