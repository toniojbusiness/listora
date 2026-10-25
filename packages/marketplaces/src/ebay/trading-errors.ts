/**
 * Trading API error codes the eBay adapter and the fake treat specially, with their documented
 * meaning (Errors by Number, https://developer.ebay.com/devzone/xml/docs/reference/ebay/errors/
 * errormessages.htm, checked 2026-10-24). Any other `Failure` is a refusal of the request as
 * sent, unless eBay classifies it as a `SystemError`.
 */
export const TRADING_ERRORS = {
  /** "This item cannot be accessed because the listing has been deleted or you are not the seller." */
  itemNotAccessible: '17',
  /** "Input data for tag <...> is invalid or missing." */
  invalidInput: '37',
  /** "Listing titles are limited to ... characters." */
  titleTooLong: '70',
  /** "The category is not valid, select another category." */
  invalidCategory: '107',
  /** "This item was not relisted because the listing does not exist or is still active." */
  cannotRelist: '196',
  /** "The item specified in your input is invalid, not activated, or no longer in our database." */
  itemNotFound: '231',
  /** "You are not allowed to revise ended listings." */
  revisedEnded: '291',
  /** "The UUID can only contain Numbers and Letters from A to F and must be 32 characters long." */
  invalidUuid: '487',
  /** "The specified UUID has already been used; isFromSameApplication=..., item ID=...." */
  duplicateUuid: '488',
  /** "Your application has exceeded usage limit on this call". */
  callLimit: '518',
  /** "Validation of the authentication token in API request failed." */
  authTokenInvalid: '931',
  /** "Auth token is hard expired". */
  authTokenHardExpired: '932',
  /** "The auction has already been closed." (ending a listing that has ended) */
  alreadyClosed: '1047',
  /** "No Item Was Found for this Item Id." */
  noItemFound: '1505',
  /** "System error. Unable to process your request. Please try again later." */
  systemError: '10007',
  /** "Third-party authorization has been revoked by the user". */
  tokenRevoked: '16110',
  /** "You have exceeded your daily request limit". */
  dailyLimit: '18000',
  /** "You can't have two active items with the same SKU number at the same time." */
  duplicateActiveSku: '21674',
  /** "Could not find an active item for the given SKU number." */
  noActiveSku: '21676',
  /** "The item has already ended". */
  alreadyEnded: '21808',
  /** "Item condition is required for this category." */
  conditionRequired: '21916884',
  /** "IAF token supplied is invalid." */
  iafTokenInvalid: '21916984',
  /** "IAF token supplied is expired." */
  iafTokenExpired: '21917053',
  /** "Add at least 1 photo." */
  photoRequired: '21919136',
  /** "You have exceeded your maximum call limit of ... for .... Try back after ...." (Add calls) */
  addCallLimit: '21919144',
  /** "The item specific ... is missing." */
  itemSpecificMissing: '21919303',
  /** "The value ... for ... is too long." */
  itemSpecificTooLong: '21919308',
} as const;

/** The seller's authorization is gone: connecting eBay again is the only fix. */
export const REAUTH_ERRORS: ReadonlySet<string> = new Set([
  TRADING_ERRORS.authTokenInvalid,
  TRADING_ERRORS.authTokenHardExpired,
  TRADING_ERRORS.tokenRevoked,
  TRADING_ERRORS.iafTokenInvalid,
]);

/** The application's Trading quota is used up until its window resets. */
export const QUOTA_ERRORS: ReadonlySet<string> = new Set([
  TRADING_ERRORS.callLimit,
  TRADING_ERRORS.dailyLimit,
]);

/** Answers that mean "no such listing" when a listing is looked up by SKU. */
export const SKU_NOT_FOUND_ERRORS: ReadonlySet<string> = new Set([
  TRADING_ERRORS.itemNotAccessible,
  TRADING_ERRORS.itemNotFound,
  TRADING_ERRORS.noItemFound,
  TRADING_ERRORS.noActiveSku,
]);

/** Ending a listing that is not live: eBay changes nothing, and a read-back decides. */
export const ALREADY_ENDED_ERRORS: ReadonlySet<string> = new Set([
  TRADING_ERRORS.alreadyClosed,
  TRADING_ERRORS.alreadyEnded,
]);

/** The listing id eBay names in a duplicate-UUID error (488): "... item ID=110012345678." */
export function duplicateUuidItemId(
  longMessage: string,
  parameters: readonly string[],
): string | null {
  const fromMessage = /item ID\s*=\s*(\d+)/i.exec(longMessage)?.[1];
  if (fromMessage !== undefined) return fromMessage;
  return parameters.find((value) => /^\d{6,19}$/.test(value)) ?? null;
}
