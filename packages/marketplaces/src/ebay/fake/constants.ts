/**
 * The fake eBay's well-known development values. They are not secrets: nothing but the fake
 * accepts them, and `EBAY_ENV=fake` uses them when no keys are configured.
 */
export const FAKE_EBAY_CLIENT_ID = 'Listora-Fake-PRD-0000000000-00000000';
export const FAKE_EBAY_CLIENT_SECRET = 'PRD-fake-0000-0000-0000-000000000000';
/** The fake keyset's RuName: its consent page accepts only this `redirect_uri`. */
export const FAKE_EBAY_RU_NAME = 'Listora-Fake-RuName';
/** The development seller's refresh token (the fake's only seller unless a test adds more). */
export const FAKE_EBAY_REFRESH_TOKEN = 'v^1.1#i^1#f^0#r^1#fake-development-seller-refresh-token';
/** The development seller's business policy ids. */
export const FAKE_EBAY_POLICIES = {
  shipping: '6000000001',
  payment: '6000000002',
  return: '6000000003',
} as const;
