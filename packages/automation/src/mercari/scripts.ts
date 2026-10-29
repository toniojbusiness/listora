/**
 * The Mercari automation scripts: how each operation is done on Mercari's pages (adapter.ts
 * describes it). They are the one definition both hosts run: the browser runner, and the
 * iPhone app for a seller whose Mercari runs on their phone (docs/features/phone-execution.md).
 */
import {
  type ListedListing,
  type OperationRequest,
  type RemoteListingState,
  type RemoteOrder,
  type RemoteOrderLabel,
} from '@listora/marketplaces';

import {
  mayHaveAppliedBefore,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/script-call.ts';
import { listingSku } from '../adapter/sku-line.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { StepRunner } from '../runner/types.ts';
import { openAccount, salesTabPath } from './pages/account-page.ts';
import { changed, type MercariSite } from './pages/common.ts';
import { activate, deactivate, editorShows, openEditor } from './pages/edit-page.ts';
import { itemUrl, readItem, type ItemRead } from './pages/item-page.ts';
import {
  fillListing,
  fillPrice,
  openSellForm,
  submitListing,
  type Submitted,
} from './pages/listing-form.ts';
import { listingDetails } from './pages/listing-details.ts';
import { readListingsPage, type ListingRow } from './pages/listings-page.ts';
import { readOrder } from './pages/order-page.ts';
import type { MercariListingPayload } from './payload.ts';

/**
 * How many of the newest active listings a lookup by SKU opens. A listing whose id Listora
 * never learned is one it just posted, so it is among the newest.
 */
export const SKU_LOOKUP_DEPTH = 8;
/** Pages of a sold tab one sale check goes through at most (newest first). */
export const MAX_SOLD_PAGES = 5;
/**
 * Listing pages one sale check opens at most per tab, for the sale times the sold rows don't
 * show (newest first).
 */
export const MAX_SOLD_READS = 12;
/** The sales history's (a check with no `since`) pages and listing pages per tab at most. */
export const HISTORY_SOLD_PAGES = 25;
export const HISTORY_SOLD_READS = 60;
/** Order pages one label read opens at most. */
export const MAX_LABEL_READS = 10;

export interface MercariScriptOptions {
  /** The site the scripts drive: Mercari, or its stand-in in development and tests. */
  site: MercariSite;
  photos: PhotoSource;
}

export function createMercariScripts(
  options: MercariScriptOptions,
): AutomationScripts<MercariListingPayload> {
  const { site } = options;

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on Mercari yet.',
  });
  const sold = (): WriteResult => ({
    type: 'rejected',
    code: 'listing_sold',
    message: 'This listing sold on Mercari, so it cannot be changed.',
    fixHint: 'List the item again as a new Mercari listing.',
  });

  const imeiRequired = (): WriteResult => ({
    type: 'rejected',
    code: 'imei_required',
    message: "Mercari asks for the phone's IMEI in this category, which Listora doesn't have.",
    fixHint: 'List this item in Mercari, where you can enter the IMEI.',
  });

  /** The listing the newest active listings hold under this SKU, if any. */
  async function findBySku(
    step: StepRunner,
    sku: string,
    title?: string,
  ): Promise<ItemRead | null> {
    const recent = await step('look at the newest listings', { mutates: false }, (page) =>
      readListingsPage(page, site, 'active', 1),
    );
    // Rows with the listing's title first: the seller's other listings needn't be opened.
    const titled = title === undefined ? [] : recent.rows.filter((row) => row.title === title);
    const candidates = titled.length > 0 ? titled : recent.rows.slice(0, SKU_LOOKUP_DEPTH);
    for (const row of candidates) {
      const read = await step('look for the SKU', { mutates: false }, (page) =>
        readItem(page, site, row.id),
      );
      if (read.state.found && read.sku === sku) return read;
    }
    return null;
  }

  /**
   * After a submit: Mercari's refusal, or the listing it opened. The listing is read back by the
   * operation's check, not here: the submit already happened.
   */
  function submitted(outcome: Submitted): WriteResult {
    if (outcome.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: outcome.message };
    }
    return outcome.itemId === null
      ? { type: 'applied' }
      : { type: 'applied', externalListingId: outcome.itemId };
  }

  /** Opens the editor of a listed, unsold listing; a result instead when it can't be edited. */
  async function editor(
    op: OperationRequest<MercariListingPayload>,
    step: StepRunner,
  ): Promise<{ id: string } | WriteResult> {
    const id = op.listing.externalListingId;
    if (id === null) return notListed();
    const opened = await step('open the editor', { mutates: false }, (page) =>
      openEditor(page, site, id),
    );
    if (opened === 'editing') return { id };
    const shown = await step('open the listing', { mutates: false }, (page) =>
      readItem(page, site, id),
    );
    if (!shown.state.found) return notListed();
    if (shown.state.status === 'sold') return sold();
    // An unsold listing whose edit page has no form: the page is not what Listora knows.
    throw changed('edit page', 'shows no listing form for a listing that has not sold');
  }

  /**
   * The edit page an end or relist acts on, and whether it shows the listing active or inactive,
   * so the change takes one page load before it acts (reading the listing's own page first took
   * another). Mercari shows no editor for a sold or removed listing; its own page then says what
   * became of it.
   */
  async function onEditor(step: StepRunner, id: string): Promise<'active' | 'inactive' | ItemRead> {
    const shown = await step('open the editor', { mutates: false }, async (page) =>
      (await openEditor(page, site, id)) === 'editing' ? editorShows(page) : null,
    );
    if (shown !== null) return shown;
    return step('open the listing', { mutates: false }, (page) => readItem(page, site, id));
  }

  /** Posts a new listing from the payload (List, or a relist of a listing Mercari removed). */
  async function createListing(
    op: OperationRequest<MercariListingPayload>,
    step: StepRunner,
  ): Promise<WriteResult> {
    const payload = op.payload;
    if (payload === null) throw new Error('a create has a payload');
    const sku = listingSku(op.listing);
    if (mayHaveAppliedBefore(op)) {
      // An earlier attempt may have gone through; Mercari would take a second copy.
      const earlier = await findBySku(step, sku, payload.title);
      if (earlier?.state.found === true) {
        return {
          type: 'applied',
          externalListingId: earlier.state.externalListingId,
          ...(earlier.state.revision === null ? {} : { revision: earlier.state.revision }),
        };
      }
    }
    const files = await step('get the photos', { mutates: false }, (_page, signal) =>
      Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
    );
    const opened = await step('open the sell page', { mutates: false, timeScale: 2 }, (page) =>
      openSellForm(page, site),
    );
    if (opened === 'verification_required') {
      return {
        type: 'rejected',
        code: 'account_verification_required',
        message: 'Mercari asks you to verify your account before you can list.',
        fixHint:
          'Open Mercari, start a listing, tap Verify, and finish its steps. Then list again.',
      };
    }
    const filled = await step('fill in the listing', { mutates: false, timeScale: 3 }, (page) =>
      fillListing(page, payload, sku, files),
    );
    if (filled === 'imei_required') return imeiRequired();
    const result = await step('list', { mutates: true, timeScale: 3 }, async (page) =>
      submitted(await submitListing(page, 'list')),
    );
    if (result.type !== 'applied' || result.externalListingId !== undefined) return result;
    // Mercari's page after List may not name the listing: it is found by its SKU in the same
    // run. Not finding it yet leaves it to the operation's check.
    try {
      const found = await findBySku(step, sku, payload.title);
      if (found?.state.found === true) {
        return { ...result, externalListingId: found.state.externalListingId };
      }
    } catch {
      // The check reads it back later.
    }
    return result;
  }

  return {
    create: (op, step) => createListing(op, step),
    revise: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a revise has a payload');
      const opened = await editor(op, step);
      if (!('id' in opened)) return opened;
      // The same whole form a create fills in, so the same time.
      const filled = await step('fill in the changes', { mutates: false, timeScale: 3 }, (page) =>
        fillListing(page, payload, listingSku(op.listing), null),
      );
      if (filled === 'imei_required') return imeiRequired();
      return step('save', { mutates: true }, async (page) =>
        submitted(await submitListing(page, 'save')),
      );
    },
    price: async (op, step) => {
      const priceCents = op.desired.priceCents;
      if (priceCents === undefined) {
        return { type: 'rejected', code: 'missing_price', message: 'There is no price to set.' };
      }
      if (priceCents % 100 !== 0 || priceCents < 100) {
        return {
          type: 'rejected',
          code: 'invalid_price',
          message: 'Mercari prices are whole dollars from $1.',
        };
      }
      const opened = await editor(op, step);
      if (!('id' in opened)) return opened;
      await step('fill in the price', { mutates: false }, (page) => fillPrice(page, priceCents));
      return step('save', { mutates: true }, async (page) =>
        submitted(await submitListing(page, 'save')),
      );
    },
    end: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await onEditor(step, id);
      // Mercari opens the seller's listings once it took it: the read-back confirms it.
      if (shown === 'active') {
        return step('deactivate', { mutates: true }, async (page) => {
          await deactivate(page);
          return { type: 'applied' };
        });
      }
      // Ended already: nothing is live, and the read-back decides.
      if (shown === 'inactive') return { type: 'applied' };
      if (!shown.state.found) return notListed();
      // Sold: nothing is live, and the read-back decides.
      if (shown.state.status !== 'active') return { type: 'applied' };
      throw changed('edit page', 'shows no listing form for an active listing');
    },
    relist: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await onEditor(step, id);
      if (shown === 'inactive') {
        return step('activate', { mutates: true }, async (page) => {
          await activate(page);
          return { type: 'applied', externalListingId: id };
        });
      }
      if (shown === 'active') return { type: 'applied', externalListingId: id };
      if (!shown.state.found) {
        // Mercari removed it (a listing deleted there): relisting posts it again, as a new
        // listing with its own id, from the item's details.
        return shown.state.authoritative ? createListing(op, step) : notListed();
      }
      if (shown.state.status === 'sold') return sold();
      if (shown.state.status === 'active') return { type: 'applied', externalListingId: id };
      throw changed('edit page', 'shows no listing form for a listing that has not sold');
    },
    // A refresh saves the listing's edit page unchanged, Mercari's own way to bring a listing
    // back to the top of search (listing-refresh.md); nothing on it changes.
    refresh: async (op, step) => {
      const id = op.listing.externalListingId;
      if (id === null) return notListed();
      const shown = await onEditor(step, id);
      if (shown === 'active') {
        return step('save unchanged', { mutates: true }, async (page) =>
          submitted(await submitListing(page, 'save')),
        );
      }
      if (shown !== 'inactive') {
        if (!shown.state.found) return notListed();
        if (shown.state.status === 'sold') return sold();
      }
      return {
        type: 'rejected',
        code: 'not_live',
        message: 'Only a listing for sale on Mercari can be refreshed.',
      };
    },
    read: async (ref, step): Promise<RemoteListingState> => {
      const id = ref.externalListingId;
      if (id !== null) {
        const read = await step('read the listing', { mutates: false }, (page) =>
          readItem(page, site, id),
        );
        return read.state;
      }
      // Found by SKU: not finding it is no proof the listing is gone.
      const found = await findBySku(step, listingSku(ref));
      return found?.state ?? { found: false, authoritative: false };
    },
    health: async (step) => {
      await step('open your account', { mutates: false }, (page) => openAccount(page, site));
      // The account page shows the seller's display name, which is neither unique nor fixed,
      // and no id: the seller stays unknown, never a guess.
      return null;
    },
    orders: async (since, step) => {
      const orders: RemoteOrder[] = [];
      // The done sales' tab is wherever the account page's Sales link goes (not `/sold/`).
      const soldPath = await step('find the sales tab', { mutates: false }, (page) =>
        salesTabPath(page, site),
      );
      const maxPages = since === null ? HISTORY_SOLD_PAGES : MAX_SOLD_PAGES;
      const maxReads = since === null ? HISTORY_SOLD_READS : MAX_SOLD_READS;
      for (const tab of ['in_progress', 'sold'] as const) {
        let reads = 0;
        tab: for (let number = 1; number <= maxPages; number += 1) {
          const shown = await step(
            `read the ${tab.replace('_', ' ')} sales`,
            { mutates: false },
            (page) =>
              readListingsPage(page, site, tab, number, tab === 'sold' ? soldPath : undefined),
          );
          for (const row of shown.rows) {
            // Rows come by their last change, newest first, and a sale changes its row: once a
            // row last changed before `since`, it and every row after it sold before then.
            if (since !== null && row.changedBy !== null && row.changedBy < since) break tab;
            let { soldAt, priceCents, title } = row;
            let listing: ListedListing | undefined;
            if (soldAt === null || priceCents === null) {
              // The row doesn't show when it sold or for how much: the listing's page does, with
              // its photos and details.
              if (reads === maxReads) break tab;
              reads += 1;
              const read = await step('read the sale', { mutates: false }, (page) =>
                readItem(page, site, row.id),
              );
              soldAt ??= read.soldAt;
              if (read.state.found) {
                priceCents ??= read.state.priceCents;
                title ||= read.state.title ?? '';
                listing = {
                  ...read.state,
                  details: listingDetails(read.record ?? {}, read.records ?? {}, read.sku),
                };
              }
            }
            if (soldAt === null || priceCents === null) continue;
            if (since !== null && soldAt < since) continue;
            // A Mercari listing sells once, so its id names the order. The sold tab holds the
            // finished ones; in progress may still wait to ship or be on its way.
            orders.push({
              externalOrderId: row.id,
              soldAt,
              ...(tab === 'sold' ? { shipped: true } : {}),
              items: [
                {
                  externalListingId: row.id,
                  title: title === '' ? null : title,
                  priceCents,
                  currency: 'USD',
                  ...(listing === undefined ? {} : { listing }),
                },
              ],
            });
          }
          if (!shown.hasNext) break;
        }
      }
      return orders;
    },
    labels: async (orders, step) => {
      const labels: RemoteOrderLabel[] = [];
      for (const order of orders.slice(0, MAX_LABEL_READS)) {
        // A Mercari order is named by its item's id (the sale check's order id).
        const read = await step('read the order', { mutates: false }, (page) =>
          readOrder(page, site, order.externalListingIds[0] ?? order.externalOrderId),
        );
        labels.push(
          read.found
            ? {
                externalOrderId: order.externalOrderId,
                found: true,
                trackingNumber: read.trackingNumber,
                buyerFirstName: read.buyerName,
              }
            : { externalOrderId: order.externalOrderId, found: false },
        );
      }
      return labels;
    },
    listings: async (cursor, step, held) => {
      // One page of the active tab, then each listing's own page, which holds its description,
      // photos, and details (the tab's rows show only a title and a price): the cursor is the
      // tab's page number. A listing Listora already has settles by its id alone, so its row is
      // all it needs: no read of its page.
      const number = cursor === null ? 1 : Number(cursor);
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`a Mercari listings cursor is a page number, not ${String(cursor)}`);
      }
      const shown = await step('read your listings for sale', { mutates: false }, (page) =>
        readListingsPage(page, site, 'active', number),
      );
      const listings: ListedListing[] = [];
      for (const row of shown.rows) {
        if (held.has(row.id)) {
          listings.push(heldListing(site, row));
          continue;
        }
        const read = await step('read a listing', { mutates: false }, (page) =>
          readItem(page, site, row.id),
        );
        // Gone or sold since the tab was read: nothing to import.
        if (!read.state.found || read.state.status !== 'active') continue;
        listings.push({
          ...read.state,
          details: listingDetails(read.record ?? {}, read.records ?? {}, read.sku),
        });
      }
      return { listings, next: shown.hasNext ? String(number + 1) : null };
    },
  };
}

/**
 * A listing Listora already has, as the active tab's row shows it: for sale, its title (empty in
 * the mobile layout) and price, and nothing the row doesn't show. Its import entry settles by its
 * id (`fromList`).
 */
function heldListing(site: MercariSite, row: ListingRow): ListedListing {
  return {
    found: true,
    externalListingId: row.id,
    externalUrl: itemUrl(site, row.id),
    status: 'active',
    title: row.title === '' ? null : row.title,
    description: null,
    priceCents: row.priceCents,
    currency: 'USD',
    revision: null,
    refreshedAt: null,
    details: {
      photoUrls: [],
      brand: null,
      size: null,
      condition: null,
      categoryRef: null,
      categoryPath: [],
      colors: [],
      originalPriceCents: null,
      sku: null,
    },
    fromList: true,
  };
}
