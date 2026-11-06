/**
 * The Vinted automation scripts (docs/features/vinted.md), which the iPhone app runs in the
 * seller's own session through the page modules in `pages/` (the browser runner runs the same
 * ones in tests). Vinted never runs in the cloud.
 *
 * - `health` (M3): opens the seller's profile settings and reads the member signed in.
 * - `listings` (M4): one page of the seller's wardrobe from Vinted's web API, then each listing
 *   for sale's own item read for its description and details, for an import.
 * - `orders` (M4, M6): the seller's sold orders, in progress and completed, each with the items
 *   that sold in it (a bundle sells several), whether it shipped, for the sales history and sale
 *   checks; an order the buyer has not paid for yet is no sale. A check also reads the newest
 *   canceled ones, and those in progress Vinted says canceled, so a sale Listora recorded of one
 *   no longer stands.
 * - `create` (M5): fills the upload form and uploads; only Upload changes anything. A later
 *   attempt first looks for the listing by its SKU line, so a create Vinted already took is
 *   never posted twice (Vinted bans the same item listed twice).
 * - `price` (M5): the edit form's price, then Save.
 * - `end` (M5): Hide, which keeps the listing; `relist`: Unhide. Never a delete: Vinted's terms
 *   ban deleting and relisting the same item. Vinted refuses to hide a listing it is reviewing,
 *   so an end waits for the review (`not_yet`).
 * - `read` (M5): the listing from Vinted's web API, by its id or else by its SKU line; one Vinted
 *   is reviewing reads as not live yet (`inReview`), never as listed.
 * - `labels` (M8): each order's shipment from its web API read, for Pack check: its carrier,
 *   tracking number, label or QR code, and ship-by date (`pages/shipment.ts`). Only reads.
 *
 * The listing scripts serve a seller only once they passed live (`LISTING_AUTOMATION_NOT_VERIFIED`
 * in `@listora/marketplaces`); until then they run only in the owner's Test mode.
 */
import type {
  ListedListing,
  ListingRef,
  RemoteListing,
  OperationRequest,
  RemoteListingState,
  RemoteOrder,
  RemoteOrderItem,
  RemoteOrderLabel,
} from '@listora/marketplaces';

import type { PhotoSource } from '../adapter/photos.ts';
import {
  mayHaveAppliedBefore,
  sellerIdentity,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/script-call.ts';
import { listingSku } from '../adapter/sku-line.ts';
import type { StepRunner } from '../runner/types.ts';
import { currentMember, openAccount, signedInMember } from './pages/account-page.ts';
import {
  orderProgress,
  orderTime,
  priceCents,
  readItem,
  readSoldOrders,
  readTransaction,
  readTransactionItems,
  readWardrobePage,
  type VintedItem,
  type VintedOrderProgress,
  type VintedOrderRecord,
} from './pages/api.ts';
import { changed, type VintedSite } from './pages/common.ts';
import { offers, openItemPage, toggleHidden } from './pages/item-page.ts';
import { listingDetails } from './pages/listing-details.ts';
import { orderLabel } from './pages/shipment.ts';
import {
  fillPrice,
  fillUploadForm,
  openEditForm,
  openUploadForm,
  submitUploadForm,
  type FillProblem,
  type Submitted,
} from './pages/upload-form.ts';
import { VINTED_LIMITS, type VintedListingPayload } from './payload.ts';
import { VINTED_ID } from './site.ts';

/** Sold-order pages (20 each) a sale check reads per state, and the orders whose items it reads. */
export const ORDER_LIMITS = { pages: 2, reads: 20 } as const;
/** What the sales history (a check with no `since`) reads at most: 200 orders per state. */
export const HISTORY_ORDER_LIMITS = { pages: 10, reads: 150 } as const;

/** The lists of sold orders read, and the step that reads each. */
const ORDER_STATES = [
  { status: 'in_progress', step: 'read your sales in progress' },
  { status: 'completed', step: 'read your completed sales' },
] as const;
/**
 * The canceled orders a check reads: the newest page, and only those paid for this long before
 * the check's `since` at the most (an order is refunded at the latest a few weeks after it was
 * paid for: 5 business days to ship it, its way to the buyer, and their 2 days). Only the list:
 * a canceled order needs no read of its own, it is matched to a sale by its id. The sales history
 * reads none: a canceled order is no sale.
 */
export const CANCELED_ORDER_LIMITS = { pages: 1, lookbackMs: 30 * 24 * 3_600_000 } as const;

/**
 * How many of the newest wardrobe listings a lookup by SKU reads. A listing whose id Listora
 * never learned is one it just posted, so it is among the newest.
 */
export const SKU_LOOKUP_DEPTH = 8;
/** How long an end waits at the soonest for Vinted to finish reviewing a listing. */
export const REVIEW_WAIT_MS = 60_000;

export interface VintedScriptOptions {
  site: VintedSite;
  photos: PhotoSource;
}

export function createVintedScripts(
  options: VintedScriptOptions,
): AutomationScripts<VintedListingPayload> {
  const { site } = options;

  /** Opens the seller's settings, a Vinted page the web API reads go from. */
  const openSettings = (step: StepRunner): Promise<void> =>
    step('open your profile settings', { mutates: false }, (page) => openAccount(page, site));

  /**
   * The listing as Vinted's web API shows it to its seller, read from an open Vinted page;
   * `null` for one it doesn't have (or a draft, which is no listing).
   */
  const readListing = (step: StepRunner, id: string): Promise<ListedItem | null> =>
    step('read the listing', { mutates: false }, async (page) => {
      await openAccount(page, site);
      return listedItem(await readItem(page, site, id));
    });

  /** The listing among the seller's newest whose description ends with this SKU, if any. */
  async function findBySku(
    step: StepRunner,
    sku: string,
    title?: string,
  ): Promise<ListedItem | null> {
    const memberId = await step('find your wardrobe', { mutates: false }, async (page) => {
      await openAccount(page, site);
      return (await currentMember(page, site)).id;
    });
    const recent = await step('look at the newest listings', { mutates: false }, (page) =>
      readWardrobePage(page, site, memberId, 1),
    );
    // Listings with the listing's title first: the seller's others needn't be read.
    const listed = recent.items.filter((one) => one.state !== null);
    const titled = title === undefined ? [] : listed.filter((one) => one.state?.title === title);
    const candidates = titled.length > 0 ? titled : listed.slice(0, SKU_LOOKUP_DEPTH);
    for (const candidate of candidates) {
      const id = candidate.state?.externalListingId;
      if (id === undefined) continue;
      const read = await step('look for the SKU', { mutates: false }, (page) =>
        readItem(page, site, id),
      );
      const found = listedItem(read);
      if (found?.sku === sku) return found;
    }
    return null;
  }

  /** Posts a new listing from the payload: the upload form, then Upload. */
  async function createListing(
    op: OperationRequest<VintedListingPayload>,
    step: StepRunner,
  ): Promise<WriteResult> {
    const payload = op.payload;
    if (payload === null) throw new Error('a create has a payload');
    const sku = listingSku(op.listing);
    if (mayHaveAppliedBefore(op)) {
      // An earlier attempt may have gone through: Vinted bans the same item listed twice.
      const earlier = await findBySku(step, sku, payload.title);
      if (earlier !== null) {
        return { type: 'applied', externalListingId: earlier.state.externalListingId };
      }
    }
    const files = await step('get the photos', { mutates: false }, (_page, signal) =>
      Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
    );
    await step('open the upload form', { mutates: false, timeScale: 2 }, (page) =>
      openUploadForm(page, site),
    );
    const problem = await step('fill in the listing', { mutates: false, timeScale: 3 }, (page) =>
      fillUploadForm(page, payload, sku, files),
    );
    if (problem !== null) return refusedFill(problem);
    const result = await step('upload', { mutates: true, timeScale: 3 }, async (page) =>
      submitted(await submitUploadForm(page)),
    );
    if (result.type !== 'applied' || result.externalListingId !== undefined) return result;
    // Vinted's page after Upload didn't name the listing: it is found by its SKU in the same
    // run. Not finding it yet leaves it to the operation's check.
    try {
      const found = await findBySku(step, sku, payload.title);
      if (found !== null) {
        return { ...result, externalListingId: found.state.externalListingId };
      }
    } catch {
      // The check reads it back later.
    }
    return result;
  }

  /**
   * The listing as a read-back: by its id, else found by its SKU line among the newest (not
   * finding it that way is no proof it is gone). One Vinted is reviewing is not live yet, and
   * never gone. A 404 for its id is not taken as gone either: Vinted's answer for an item its
   * seller deleted is not read yet, and a new upload may not be readable at once.
   */
  async function readBack(ref: ListingRef, step: StepRunner): Promise<RemoteListingState> {
    const id = ref.externalListingId;
    const read = id === null ? await findBySku(step, listingSku(ref)) : await readListing(step, id);
    if (read === null) return { found: false, authoritative: false };
    if (read.inReview) return { found: false, authoritative: false, inReview: true };
    return read.state;
  }

  return {
    create: (op, step) => createListing(op, step),
    price: async (op, step) => {
      const priceCents = op.desired.priceCents;
      if (priceCents === undefined) {
        return { type: 'rejected', code: 'missing_price', message: 'There is no price to set.' };
      }
      if (priceCents < VINTED_LIMITS.minPriceCents || priceCents > VINTED_LIMITS.maxPriceCents) {
        return {
          type: 'rejected',
          code: 'invalid_price',
          message: 'Vinted prices are from $1 to $5,000.',
        };
      }
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      // Vinted shows no edit form for a listing that sold, or one it is reviewing.
      const shown = await readListing(step, id);
      if (shown === null) return notListed();
      if (shown.state.status === 'sold') return sold();
      if (shown.inReview) return inReview('changed');
      const opened = await step('open the edit form', { mutates: false, timeScale: 2 }, (page) =>
        openEditForm(page, site, id),
      );
      if (opened === 'missing') return notListed();
      if (opened === 'not_editable') {
        throw changed('edit form', 'shows no price for a listing that has not sold');
      }
      await step('fill in the price', { mutates: false }, (page) => fillPrice(page, priceCents));
      return step('save', { mutates: true, timeScale: 2 }, async (page) =>
        submitted(await submitUploadForm(page)),
      );
    },
    end: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await readListing(step, id);
      if (shown === null) return notListed();
      // Sold or hidden already: nothing is live, and the read-back decides.
      if (shown.state.status !== 'active') return { type: 'applied' };
      // Vinted won't hide (or delete) a listing it is reviewing: wait for the review.
      if (shown.inReview) return inReview('hidden');
      return step('hide', { mutates: true }, async (page) => {
        if (!(await openItemPage(page, site, id)) || !(await offers(page, 'hide'))) {
          throw changed('listing page', 'offers no Hide for a listing for sale');
        }
        await toggleHidden(page, 'hide');
        return { type: 'applied' };
      });
    },
    relist: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await readListing(step, id);
      if (shown === null) return notListed();
      if (shown.state.status === 'sold') return sold();
      // For sale already, or in Vinted's review on its way there: the read-back decides.
      if (shown.state.status === 'active') return { type: 'applied', externalListingId: id };
      return step('unhide', { mutates: true }, async (page) => {
        if (!(await openItemPage(page, site, id)) || !(await offers(page, 'unhide'))) {
          throw changed('listing page', 'offers no Unhide for a hidden listing');
        }
        await toggleHidden(page, 'unhide');
        return { type: 'applied', externalListingId: id };
      });
    },
    read: async (ref, step) => readBack(ref, step),
    health: (step) =>
      step('open your profile settings', { mutates: false }, async (page) => {
        await openAccount(page, site);
        return sellerIdentity(await signedInMember(page, site));
      }),
    listings: async (cursor, step, held) => {
      // The cursor is the wardrobe's page number. A listing Listora already has settles by its
      // id alone, so the wardrobe's record of it is all it needs: no read of its own.
      const number = cursor === null ? 1 : Number(cursor);
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`a Vinted listings cursor is a page number, not ${String(cursor)}`);
      }
      const memberId = await step('find your wardrobe', { mutates: false }, async (page) => {
        await openAccount(page, site);
        return (await currentMember(page, site)).id;
      });
      const shown = await step('read your listings for sale', { mutates: false }, (page) =>
        readWardrobePage(page, site, memberId, number),
      );
      const listings: ListedListing[] = [];
      for (const listed of shown.items) {
        if (listed.state?.status !== 'active') continue;
        const { externalListingId } = listed.state;
        if (held.has(externalListingId)) {
          listings.push({ ...listedListing(listed), fromList: true });
          continue;
        }
        const read = await step('read a listing', { mutates: false }, (page) =>
          readItem(page, site, externalListingId),
        );
        // Gone, sold, or hidden since the wardrobe was read: nothing to import.
        if (read?.state?.status !== 'active') continue;
        listings.push(listedListing(read));
      }
      return { listings, next: shown.hasNext ? String(number + 1) : null };
    },
    orders: async (since, step) => {
      await openSettings(step);
      const limits = since === null ? HISTORY_ORDER_LIMITS : ORDER_LIMITS;
      const orders: RemoteOrder[] = [];
      const seen = new Set<string>();
      for (const state of ORDER_STATES) {
        let reads = 0;
        state: for (let number = 1; number <= limits.pages; number += 1) {
          const shown = await step(state.step, { mutates: false }, (page) =>
            readSoldOrders(page, site, state.status, number),
          );
          for (const order of shown.orders) {
            const soldAt = orderTime(order);
            // Newest first: once one was paid for before `since`, so was every one after it.
            if (since !== null && soldAt < since) break state;
            if (seen.has(order.transaction_id)) continue;
            const progress = orderProgress(order, state.status);
            // Not paid for yet (an accepted offer): no sale, and nothing to read.
            if (progress === 'unpaid') continue;
            seen.add(order.transaction_id);
            if (progress === 'canceled') {
              orders.push(canceledOrder(order, soldAt));
              continue;
            }
            if (reads === limits.reads) break state;
            reads += 1;
            const items = await step('read the order', { mutates: false }, (page) =>
              readTransactionItems(page, site, order.transaction_id),
            );
            // Gone since the list was read (Vinted deleted it): nothing Listora can tell of it.
            if (items === null) continue;
            const shipped = shippedFrom(progress);
            orders.push({
              externalOrderId: order.transaction_id,
              soldAt,
              ...(shipped === undefined ? {} : { shipped }),
              items: orderItems(order, items),
            });
          }
          if (!shown.hasNext) break;
        }
      }
      if (since === null) return orders;
      // The newest canceled orders, so a sale Listora recorded of one no longer stands.
      const oldest = since.getTime() - CANCELED_ORDER_LIMITS.lookbackMs;
      canceled: for (let number = 1; number <= CANCELED_ORDER_LIMITS.pages; number += 1) {
        const shown = await step('read your canceled sales', { mutates: false }, (page) =>
          readSoldOrders(page, site, 'canceled', number),
        );
        for (const order of shown.orders) {
          const soldAt = orderTime(order);
          if (soldAt.getTime() < oldest) break canceled;
          if (seen.has(order.transaction_id)) continue;
          seen.add(order.transaction_id);
          orders.push(canceledOrder(order, soldAt));
        }
        if (!shown.hasNext) break;
      }
      return orders;
    },
    labels: async (orders, step) => {
      // One read per order, by its transaction id (Listora names a Vinted sale by it).
      if (orders.length === 0) return [];
      await openSettings(step);
      const labels: RemoteOrderLabel[] = [];
      for (const order of orders) {
        // Not a Vinted order id: no order of Vinted's to read.
        if (!VINTED_ID.test(order.externalOrderId)) {
          labels.push({ externalOrderId: order.externalOrderId, found: false });
          continue;
        }
        const transaction = await step('read the order', { mutates: false }, (page) =>
          readTransaction(page, site, order.externalOrderId),
        );
        labels.push(
          transaction === null
            ? { externalOrderId: order.externalOrderId, found: false }
            : orderLabel(order, transaction, site),
        );
      }
      return labels;
    },
  };
}

/** An item that is a listing: not a draft. */
type ListedItem = VintedItem & { state: RemoteListing };

function listedItem(item: VintedItem | null): ListedItem | null {
  const state = item?.state ?? null;
  return item === null || state === null ? null : { ...item, state };
}

/** A change to a listing that is not on Vinted (yet, or any more). */
function notListed(): WriteResult {
  return { type: 'rejected', code: 'not_listed', message: 'This listing is not on Vinted.' };
}

function sold(): WriteResult {
  return {
    type: 'rejected',
    code: 'listing_sold',
    message: 'This listing sold on Vinted, so it cannot be changed.',
    fixHint: 'List the item again as a new Vinted listing.',
  };
}

/** Vinted reviews the listing and won't let it be changed (`hidden`, `changed`) until it's done. */
function inReview(what: 'hidden' | 'changed'): WriteResult {
  return {
    type: 'not_yet',
    code: 'in_review',
    message: `Vinted is reviewing this listing and won't let it be ${what} until the review ends. Listora tries again.`,
    retryAfterMs: REVIEW_WAIT_MS,
  };
}

/**
 * After Upload or Save: Vinted's refusal, or the listing it opened. The listing is read back by
 * the operation's check, not here: the submit already happened.
 */
function submitted(outcome: Submitted): WriteResult {
  if (outcome.type === 'refused') {
    return { type: 'rejected', code: 'validation_failed', message: outcome.message };
  }
  return outcome.itemId === null
    ? { type: 'applied' }
    : { type: 'applied', externalListingId: outcome.itemId };
}

/** A form that can't take the listing as it is, before anything was sent. */
function refusedFill(problem: FillProblem): WriteResult {
  switch (problem.type) {
    case 'size_not_offered':
      return {
        type: 'rejected',
        code: 'size_not_offered',
        message:
          problem.size === null
            ? `Vinted needs a size for this category${examples(problem.offered)}.`
            : `Vinted doesn't offer size ${problem.size} for this category${examples(problem.offered)}.`,
        fixHint: "Set the listing's Size to one of Vinted's sizes, or list it in Vinted.",
      };
    case 'package_size_required':
      return {
        type: 'rejected',
        code: 'package_size_required',
        message: 'Vinted needs a package size for this listing, and it recommends none.',
        fixHint: "Add a Package size (small, medium, or large) to the listing's details.",
      };
  }
}

function examples(offered: readonly string[]): string {
  return offered.length === 0 ? '' : ` (its sizes include ${offered.join(', ')})`;
}

/** An item for sale as an import takes it, with its details. */
function listedListing(item: VintedItem): ListedListing {
  if (item.state === null) throw new Error('a draft is not a listing');
  return { ...item.state, details: listingDetails(item.record, item.sku) };
}

/**
 * Whether an order shipped: sent, on its way, delivered, or completed (delivered, and the buyer
 * confirmed it or two days passed), or still waiting to be sent; unknown words say nothing.
 */
function shippedFrom(progress: VintedOrderProgress): boolean | undefined {
  if (progress === 'shipped' || progress === 'completed') return true;
  if (progress === 'to_ship') return false;
  return undefined;
}

/**
 * A canceled order as its list shows it: no sale, so no items; it is matched to a sale Listora
 * recorded by its id alone.
 */
function canceledOrder(order: VintedOrderRecord, soldAt: Date): RemoteOrder {
  return { externalOrderId: order.transaction_id, soldAt, canceled: true, items: [] };
}

/**
 * The order's items: each that sold in it, at its own price (a bundle's), or the order's price
 * when it sold one; the order's own title and price when its read showed no item.
 */
function orderItems(order: VintedOrderRecord, items: readonly VintedItem[]): RemoteOrderItem[] {
  if (items.length === 0) {
    return [
      {
        externalListingId: null,
        title: order.title ?? null,
        priceCents: priceCents(order.price, undefined),
        currency: 'USD',
      },
    ];
  }
  return items.flatMap((item): RemoteOrderItem[] => {
    if (item.state === null) return [];
    const listing: ListedListing = {
      ...item.state,
      status: 'sold',
      details: listingDetails(item.record, item.sku),
    };
    return [
      {
        externalListingId: item.state.externalListingId,
        title: item.state.title ?? order.title ?? null,
        priceCents:
          items.length === 1 && order.price !== undefined
            ? priceCents(order.price, undefined)
            : (item.state.priceCents ?? 0),
        currency: 'USD',
        listing,
      },
    ];
  });
}
