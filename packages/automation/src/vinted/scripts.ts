/**
 * The Vinted automation scripts (docs/features/vinted.md), which the browser runner and the
 * iPhone app run in the seller's own session through the page modules in `pages/`. Every one
 * only reads:
 *
 * - `health` (M3): opens the seller's profile settings and reads the member signed in.
 * - `listings` (M4): one page of the seller's wardrobe from Vinted's web API, then each listing
 *   for sale's own item read for its description and details, for an import.
 * - `orders` (M4): the seller's sold orders, in progress and completed (never canceled), each
 *   with the items that sold in it (a bundle sells several), for the sales history and sale
 *   checks.
 *
 * The listing scripts (create, price, hide, unhide, read-back) come with M5; until then every
 * Vinted step is the seller's assisted task, and the automation adapter never runs one here.
 */
import type {
  AssistedListingPayload,
  ListedListing,
  RemoteOrder,
  RemoteOrderItem,
} from '@listora/marketplaces';

import { sellerIdentity, type AutomationScripts } from '../adapter/script-call.ts';
import { PageChangedError } from '../runner/errors.ts';
import type { StepRunner } from '../runner/types.ts';
import { currentMember, openAccount, signedInMember } from './pages/account-page.ts';
import {
  orderTime,
  priceCents,
  readItem,
  readSoldOrders,
  readTransactionItems,
  readWardrobePage,
  type VintedItem,
  type VintedOrderRecord,
} from './pages/api.ts';
import type { VintedSite } from './pages/common.ts';
import { listingDetails } from './pages/listing-details.ts';

/** Sold-order pages (20 each) a sale check reads per state, and the orders whose items it reads. */
export const ORDER_LIMITS = { pages: 2, reads: 20 } as const;
/** What the sales history (a check with no `since`) reads at most: 200 orders per state. */
export const HISTORY_ORDER_LIMITS = { pages: 10, reads: 150 } as const;

/** The states of sold orders read, and the step that reads each. Canceled ones never are. */
const ORDER_STATES = [
  { status: 'in_progress', step: 'read your sales in progress' },
  { status: 'completed', step: 'read your completed sales' },
] as const;

export interface VintedScriptOptions {
  site: VintedSite;
}

export function createVintedScripts(
  options: VintedScriptOptions,
): AutomationScripts<AssistedListingPayload> {
  const { site } = options;

  /** Opens the seller's settings, a Vinted page the web API reads go from. */
  const openSettings = (step: StepRunner): Promise<void> =>
    step('open your profile settings', { mutates: false }, (page) => openAccount(page, site));

  return {
    read: () =>
      // Never asked: no Vinted step is automated before M5, so nothing reads a listing back.
      Promise.reject(new PageChangedError("Listora doesn't read Vinted listings back yet.")),
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
            if (reads === limits.reads) break state;
            reads += 1;
            const items = await step('read the order', { mutates: false }, (page) =>
              readTransactionItems(page, site, order.transaction_id),
            );
            // Gone since the list was read (Vinted deleted it): nothing Listora can tell of it.
            if (items === null) continue;
            orders.push({
              externalOrderId: order.transaction_id,
              soldAt,
              // A completed order was delivered and the buyer confirmed it (or two days passed).
              ...(state.status === 'completed' ? { shipped: true } : {}),
              items: orderItems(order, items),
            });
          }
          if (!shown.hasNext) break;
        }
      }
      return orders;
    },
  };
}

/** An item for sale as an import takes it, with its details. */
function listedListing(item: VintedItem): ListedListing {
  if (item.state === null) throw new Error('a draft is not a listing');
  return { ...item.state, details: listingDetails(item.record, item.sku) };
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
