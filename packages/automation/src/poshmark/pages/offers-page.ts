/**
 * The seller's offers on Poshmark (docs/features/offers.md). `/offers/my_offers` ("Active
 * Offers") embeds them in `$_order_activity.orderActivity.activeOffers`: one story per side,
 * `purchase_offer_summaries` (the seller's own offers as a buyer) and `sale_offer_summaries`
 * (buyers' offers on the seller's listings), each with `content.data` and its `content.type`;
 * `activeOffersMeta.offers_pending_response_count.waiting_on_seller` counts the ones waiting on
 * the seller. Read on the captain's session (2026-10-27), which had no offer: both stories were
 * `info_message`s ("No Active Offers"), so an offer's own record is read by field names only
 * (adapter/offer-fields.ts) until a session shows one. Only the `sale_offer_summaries` story is
 * read; an offer's page is its record's link, else `/offers/<id>`. The page fills that data
 * after load (its `active-offer-section` appears then), so the read waits for it.
 */
import { z } from 'zod';

import type { OfferTurn, RemoteOffer } from '@listora/marketplaces';

import { dollarsToCents, offerOf, type OfferFieldNames } from '../../adapter/offer-fields.ts';
import { DEFAULT_OFFER_PAGE, type OfferPages } from '../../adapter/offer-page.ts';
import { texts } from '../../adapter/label-fields.ts';
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import type { PoshmarkSite } from '../site.ts';
import { expectShape, readPageState } from './state.ts';

const PAGE = 'offers page';
/**
 * The page draws its offers after load, from `/vm-rest/users/<id>/offers/feed`, and only then
 * holds them in its data (read 2026-10-27: the data just after load had no `$_order_activity`).
 */
const OFFERS_SECTION = '[data-test="active-offer-section"]';

/** The story of buyers' offers on the seller's listings. */
export const SALE_OFFERS_STORY = 'sale_offer_summaries';
/** A story's content when it has no offer. */
const NO_OFFERS = 'info_message';

const offersSchema = z.object({
  $_order_activity: z.object({
    orderActivity: z.object({
      activeOffers: z.array(
        z
          .object({
            story_type: z.string(),
            content: z
              .object({ type: z.string(), data: z.array(z.record(z.string(), z.unknown())) })
              .catchall(z.unknown()),
          })
          .catchall(z.unknown()),
      ),
    }),
  }),
});

/** The buyers' offers on the seller's listings that the page shows. Only reads. */
export async function readOffers(page: PageDriver, site: PoshmarkSite): Promise<RemoteOffer[]> {
  await page.goto(site.offers());
  await page.waitFor(OFFERS_SECTION, 'attached');
  const state = expectShape(offersSchema, await readPageState(page, PAGE), PAGE);
  const story = state.$_order_activity.orderActivity.activeOffers.find(
    (entry) => entry.story_type === SALE_OFFERS_STORY,
  );
  if (story === undefined)
    throw new PageChangedError(`Poshmark's ${PAGE} has no offers on your listings`);
  if (story.content.type === NO_OFFERS) return [];
  return story.content.data.map((record) => {
    const offer = offerOf(record, fieldNames(site));
    if (offer === null)
      throw new PageChangedError(`Poshmark's ${PAGE} shows an offer Listora can't read`);
    return offer;
  });
}

/** Poshmark's offer pages (adapter/offer-page.ts). */
export function poshmarkOfferPages(site: PoshmarkSite): OfferPages {
  return {
    name: 'Poshmark',
    selectors: DEFAULT_OFFER_PAGE,
    url: (ref) => ref.url ?? site.offer(ref.externalOfferId),
  };
}

function fieldNames(site: PoshmarkSite): OfferFieldNames {
  return {
    listing: ['post_id', 'listing_id', 'postId'],
    money: dollarsToCents,
    turn,
    url: (record, id) => {
      const link = texts([record['offer_url'], record['target_url'], record['url']])[0];
      if (link === undefined) return site.offer(id);
      try {
        const url = new URL(link, site.origin);
        return url.origin === site.origin ? url.href : site.offer(id);
      } catch {
        return site.offer(id);
      }
    },
  };
}

/** Whose turn the record says it is (`waiting_on`, or a status naming the seller or buyer). */
function turn(record: Readonly<Record<string, unknown>>): OfferTurn | null {
  const said = texts([record['waiting_on'], record['offer_status'], record['status']])
    .join(' ')
    .toLowerCase();
  if (/seller|pending/.test(said)) return 'seller';
  if (/buyer|countered/.test(said)) return 'buyer';
  return null;
}
