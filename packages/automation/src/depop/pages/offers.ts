/**
 * The seller's offers on Depop (docs/features/offers.md), read from Depop's web API the way its
 * selling hub's Offers page reads them (read on a real shop's session, 2026-10-28, and Depop's
 * public scripts):
 *
 * - `GET /presentation/api/v1/offers/me/products/?after=<page_info.last>`: the products that have
 *   offers (`{ objects, page_info: { has_more, last } }`; `cursor=` is ignored);
 * - per product, `GET /presentation/api/v1/products/<id>/offers/?active=true&include_size=true
 *   &variant_id=<variant>&after=<last>`: its offers, each with `offer_id`, `offer_value`,
 *   `offer_display_status`, `expires_at`, `can_make_counter_offer`, and the offerer's username.
 *
 * The Offers page counts the seller's own offers too: offers she sent to the people who liked a
 * listing (`SENT_PRIVATE_OFFER`), most of a real shop's offers. Only an offer a buyer made waits
 * on the seller: a status ending in `RECEIVED` (an `EXPIRED_RECEIVED` one no longer does). The
 * seller's sent offers, accepted, declined, expired, and sold ones are never shown as needing
 * her; a status Listora doesn't know stops the read (`PageChangedError`), so a buyer's offer is
 * never missed or guessed. Only reads.
 */
import { z } from 'zod';

import type { OfferRef, RemoteOffer, RemoteOfferState } from '@listora/marketplaces';

import { texts } from '../../adapter/label-fields.ts';
import { dollarsToCents } from '../../adapter/offer-fields.ts';
import { DEFAULT_OFFER_PAGE, type OfferPages } from '../../adapter/offer-page.ts';
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { onDepop } from './api.ts';
import { absolute, changed, type DepopSite } from './common.ts';
import { expectShape } from './page-data.ts';

const API = 'web API';
/** The cookie Depop's pages send as their bearer token. */
const TOKEN_COOKIE = 'access_token';
/** Pages of products and of one product's offers a read follows at most. */
const MAX_PAGES = 10;

const pageSchema = z.object({
  objects: z.array(z.record(z.string(), z.unknown())),
  page_info: z
    .object({ has_more: z.boolean(), last: z.union([z.string(), z.number()]).nullish() })
    .catchall(z.unknown()),
});

/** What an offer's `offer_display_status` says, in Listora's terms. */
export type DepopOfferStatus =
  Extract<RemoteOfferState, { found: true }>['status'] | 'not_the_sellers' | 'inactive';

/** An offer's status: whose it is and how it stands. `null` for one Listora doesn't know. */
export function depopOfferStatus(status: string): DepopOfferStatus | null {
  const value = status.toUpperCase();
  if (/^(EXPIRED|SOLD)_/.test(value)) return 'inactive';
  if (value.endsWith('RECEIVED')) return 'pending';
  if (value === 'ACCEPTED') return 'accepted';
  if (value.startsWith('DECLINED')) return 'declined';
  if (value.includes('COUNTER')) return 'countered';
  // The seller's own offers to likers, and the other offers she sent.
  if (/(_PRIVATE_OFFER|^SENT_|_SENT$)/.test(value)) return 'not_the_sellers';
  return null;
}

/** One product with offers, as the products list names it. */
interface OfferProduct {
  id: string;
  slug: string | null;
  title: string | null;
  variantId: string | null;
}

/** The buyers' offers waiting on the seller, across her products. Only reads. */
export async function readOffers(page: PageDriver, site: DepopSite): Promise<RemoteOffer[]> {
  await onDepop(page, site);
  const offers: RemoteOffer[] = [];
  for (const product of await readProducts(page, site)) {
    for (const record of await readProductOffers(page, site, product, true)) {
      const offer = offerOf(record, product, site);
      if (offer?.status === 'pending') offers.push(offer.offer);
    }
  }
  return offers;
}

/** One offer as Depop shows it now (the read-back of an answer). Only reads. */
export async function readOffer(
  page: PageDriver,
  site: DepopSite,
  ref: OfferRef,
): Promise<RemoteOfferState> {
  const ids = splitOfferId(ref.externalOfferId);
  if (ids === null) return { found: false };
  await onDepop(page, site);
  const product: OfferProduct = {
    id: ids.productId,
    slug: ref.externalListingId,
    title: null,
    variantId: ids.variantId,
  };
  for (const active of [true, false]) {
    for (const record of await readProductOffers(page, site, product, active)) {
      const offer = offerOf(record, product, site);
      if (offer?.offer.externalOfferId !== ref.externalOfferId) continue;
      if (offer.status === 'not_the_sellers' || offer.status === 'inactive')
        return { found: false };
      return { found: true, offer: offer.offer, status: offer.status };
    }
  }
  return { found: false };
}

/**
 * Depop's offer pages for an answer (adapter/offer-page.ts): the selling hub's offer, by its id.
 * Depop's own page for one offer has not been seen with a buyer's offer on it, so its selectors are
 * the fake Depop's; a real page without them hands the answer to the seller.
 */
export function depopOfferPages(site: DepopSite): OfferPages {
  return {
    name: 'Depop',
    selectors: DEFAULT_OFFER_PAGE,
    url: (ref) =>
      absolute(
        site,
        DEPOP_PATHS.offer(splitOfferId(ref.externalOfferId)?.offerId ?? ref.externalOfferId),
      ),
  };
}

/** Listora's id of a Depop offer: its product, its variant (if any), and the offer's own id. */
export function depopOfferId(productId: string, variantId: string | null, offerId: string): string {
  return [productId, variantId ?? '', offerId].join('/');
}

function splitOfferId(
  id: string,
): { productId: string; variantId: string | null; offerId: string } | null {
  const [productId, variantId, offerId, ...rest] = id.split('/');
  if (productId === undefined || offerId === undefined || productId === '' || offerId === '')
    return null;
  if (rest.length > 0) return null;
  return {
    productId,
    variantId: variantId === '' || variantId === undefined ? null : variantId,
    offerId,
  };
}

async function readProducts(page: PageDriver, site: DepopSite): Promise<OfferProduct[]> {
  const products: OfferProduct[] = [];
  let after: string | null = null;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const query = after === null ? '' : `?after=${encodeURIComponent(after)}`;
    const shown = await apiPage(
      page,
      `${site.api}/presentation/api/v1/offers/me/products/${query}`,
    );
    for (const object of shown.objects) {
      const [id] = texts([object['id'], object['product_id']]);
      if (id === undefined) throw changed(API, 'lists a product with offers without its id');
      products.push({
        id,
        slug: texts([object['slug'], object['product_slug']])[0] ?? null,
        title: texts([object['title'], object['description']])[0]?.split('\n')[0] ?? null,
        variantId: texts([object['variant_id']])[0] ?? null,
      });
    }
    after = nextPage(shown);
    if (after === null) break;
  }
  return products;
}

async function readProductOffers(
  page: PageDriver,
  site: DepopSite,
  product: OfferProduct,
  active: boolean,
): Promise<Readonly<Record<string, unknown>>[]> {
  const records: Readonly<Record<string, unknown>>[] = [];
  let after: string | null = null;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const query = new URLSearchParams({ active: String(active), include_size: 'true' });
    if (product.variantId !== null) query.set('variant_id', product.variantId);
    if (after !== null) query.set('after', after);
    const shown = await apiPage(
      page,
      `${site.api}/presentation/api/v1/products/${encodeURIComponent(product.id)}/offers/?${query.toString()}`,
    );
    records.push(...shown.objects);
    after = nextPage(shown);
    if (after === null) break;
  }
  return records;
}

async function apiPage(page: PageDriver, url: string): Promise<z.infer<typeof pageSchema>> {
  const answer = await page.apiGet(url, { bearerCookie: TOKEN_COOKIE });
  if (answer.status !== 200) throw changed(API, `answered ${String(answer.status)} for offers`);
  return expectShape(pageSchema, answer.body, API);
}

function nextPage(shown: z.infer<typeof pageSchema>): string | null {
  const last = shown.page_info.last;
  return shown.page_info.has_more && last !== undefined && last !== null ? String(last) : null;
}

/** One offer record, read by its field names; `null` for a record that names no offer. */
function offerOf(
  record: Readonly<Record<string, unknown>>,
  product: OfferProduct,
  site: DepopSite,
): { offer: RemoteOffer; status: DepopOfferStatus } | null {
  const [offerId] = texts([record['offer_id'], record['id']]);
  const [statusText] = texts([record['offer_display_status'], record['status']]);
  if (offerId === undefined || statusText === undefined) {
    throw changed(API, "shows an offer Listora can't read");
  }
  const status = depopOfferStatus(statusText);
  if (status === null)
    throw changed(API, `shows an offer status Listora doesn't know (${statusText.slice(0, 40)})`);
  if (status === 'not_the_sellers' || status === 'inactive')
    return { status, offer: placeholder(offerId, product) };
  const amountCents = dollarsToCents(record['offer_value'] ?? record['value']);
  if (amountCents === null || amountCents <= 0)
    throw changed(API, 'shows an offer without its amount');
  const offerer = record['offerer'] ?? record['buyer'] ?? record['user'];
  const buyerName =
    typeof offerer === 'object' && offerer !== null
      ? (texts([(offerer as Record<string, unknown>)['username']])[0] ?? null)
      : (texts([record['offerer_username'], record['username']])[0] ?? null);
  const expires = texts([record['expires_at']])[0];
  return {
    status,
    offer: {
      externalOfferId: depopOfferId(product.id, product.variantId, offerId),
      externalListingId: product.slug,
      listingTitle: product.title?.slice(0, 200) ?? null,
      amountCents,
      listPriceCents: dollarsToCents(record['original_price'] ?? record['product_price']),
      buyerName: buyerName?.slice(0, 100) ?? null,
      turn: status === 'pending' ? 'seller' : 'buyer',
      madeAt: isoOrNull(texts([record['created_at'], record['created']])[0]),
      expiresAt: isoOrNull(expires),
      // The selling hub's Offers page, where the seller answers it on Depop.
      url: absolute(site, DEPOP_PATHS.offers),
      listingCount: null,
      shippingCents: null,
    },
  };
}

function placeholder(offerId: string, product: OfferProduct): RemoteOffer {
  return {
    externalOfferId: depopOfferId(product.id, product.variantId, offerId),
    externalListingId: product.slug,
    listingTitle: null,
    amountCents: 1,
    listPriceCents: null,
    buyerName: null,
    turn: 'buyer',
    madeAt: null,
    expiresAt: null,
    url: null,
    listingCount: null,
    shippingCents: null,
  };
}

function isoOrNull(text: string | undefined): string | null {
  if (text === undefined) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
