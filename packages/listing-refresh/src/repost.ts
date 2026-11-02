/**
 * What a repost refresh posts again (docs/features/listing-refresh.md): the listing as Listora
 * wrote it. The item and its photos come from the newest confirmed operation that carried the
 * listing's content (the photos the listing was posted with); the variant (text, price,
 * category, condition, aspects, and hashtags) comes from the listing itself, so a price change
 * since is kept.
 */
import type { DbExecutor } from '@listora/db';
import {
  ITEM_CONDITIONS,
  parseListingContent,
  type ListingAspect,
  type ListingContent,
} from '@listora/marketplaces';

/** The content of the listing's fresh copy; `null` for a listing Listora didn't write. */
export async function repostContent(
  executor: DbExecutor,
  accountId: string,
  listingId: string,
): Promise<ListingContent | null> {
  const listing = await executor
    .selectFrom('marketplace_listing')
    .select([
      'title',
      'description',
      'price_cents',
      'currency',
      'category_ref',
      'condition',
      'aspects',
      'hashtags',
    ])
    .where('account_id', '=', accountId)
    .where('id', '=', listingId)
    .executeTakeFirst();
  if (listing === undefined || listing.title === null || listing.price_cents === null) return null;
  const written = await executor
    .selectFrom('marketplace_operation')
    .select('content')
    .where('account_id', '=', accountId)
    .where('listing_id', '=', listingId)
    .where('kind', 'in', ['create', 'revise', 'relist', 'refresh'])
    .where('status', '=', 'succeeded')
    .where('content', 'is not', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (written === undefined || written.content === null) return null;
  const { item } = parseListingContent(written.content);
  return {
    item,
    variant: {
      title: listing.title,
      description: listing.description ?? '',
      price: { amountCents: listing.price_cents, currency: listing.currency },
      categoryRef: listing.category_ref,
      condition: ITEM_CONDITIONS.find((value) => value === listing.condition) ?? null,
      aspects: Array.isArray(listing.aspects)
        ? (listing.aspects as unknown as ListingAspect[])
        : [],
      hashtags: [...listing.hashtags],
    },
  };
}
