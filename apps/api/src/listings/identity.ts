import { assertNever, parseListingUrl } from '@listora/shared';

import { validationFailed } from '../errors.ts';
import type { ListingIdentity } from './repository.ts';
import { marketplaceName } from './views.ts';

/** The marketplace and listing a shared URL names, or `422` on `field` saying why it is not one. */
export function identityFromUrl(url: string, field = 'url'): ListingIdentity {
  const parsed = parseListingUrl(url);
  switch (parsed.kind) {
    case 'listing':
      return {
        marketplace: parsed.marketplace,
        listingId: parsed.listingId,
        url: parsed.canonicalUrl,
      };
    case 'not_listing':
      throw validationFailed(
        [
          {
            field,
            message: `is a ${marketplaceName(parsed.marketplace)} page but not a single listing`,
          },
        ],
        `This is not a ${marketplaceName(parsed.marketplace)} listing. Share the listing itself.`,
      );
    case 'unsupported':
      throw validationFailed(
        [{ field, message: 'is not a listing on eBay, Depop, Poshmark, or Mercari' }],
        'Listora links listings from eBay, Depop, Poshmark, and Mercari. Share a listing from one of them.',
      );
    default:
      return assertNever(parsed);
  }
}
